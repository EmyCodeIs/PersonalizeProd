'use strict';

const assert = require('assert/strict');

process.env.QR_ADMIN_DETAIL_TOKEN = 'connection-health-secret';

const { connectionConfig } = require('../src/config/connectionConfig');
const {
  ConnectionSupervisor,
  setActiveConnectionSupervisor,
} = require('../src/services/connectionSupervisor');
const {
  detailAuthorized,
  detailPayload,
  readinessPayload,
  setQrAdminClient,
} = require('../src/services/qrAdminServer');

function run() {
  const supervisor = new ConnectionSupervisor({
    config: {
      syncTimeoutMs: 60000,
      recoveryDelayMs: 60000,
      recoveryCooldownMs: 60000,
      maxRecoveryAttempts: 3,
      exitOnFailure: false,
    },
    logger: { log() {}, warn() {}, error() {} },
  });
  supervisor.beginGeneration('health-test');
  setActiveConnectionSupervisor(supervisor);

  assert.equal(connectionConfig.deviceSyncTimeoutMs, 180000);
  assert.equal(connectionConfig.waitForReadyBeforeChannelReturn, true);

  const starting = readinessPayload();
  assert.equal(starting.live, true);
  assert.equal(starting.ready, false);
  assert.equal(starting.connection.state, 'STARTING');

  supervisor.observeState('SYNCING', { source: 'test' });
  const syncing = readinessPayload();
  assert.equal(syncing.ready, false);
  assert.equal(syncing.connection.state, 'SYNCING');

  const fakeClient = {
    page: {},
    async getConnectionState() { return 'CONNECTED'; },
    async isConnected() { return true; },
    async isMainReady() { return true; },
    async logout() { return true; },
  };
  setQrAdminClient(fakeClient);
  supervisor.attachClient(fakeClient, supervisor.generation);
  supervisor.observeState('CONNECTED', { source: 'test' });
  supervisor.markInbound();
  supervisor.markOutbound();

  const ready = readinessPayload();
  assert.equal(ready.ready, true);
  assert.equal(ready.connection.state, 'READY');
  assert.ok(ready.connection.lastReadyAt);
  assert.ok(ready.connection.lastInboundAt);
  assert.ok(ready.connection.lastOutboundAt);

  const unauthorized = detailAuthorized({ headers: {} });
  const authorized = detailAuthorized({
    headers: { authorization: 'Bearer connection-health-secret' },
  });
  assert.equal(unauthorized, false);
  assert.equal(authorized, true);

  const detail = detailPayload();
  assert.equal(detail.live, true);
  assert.equal(detail.ready, true);
  assert.equal(detail.connection.generation, supervisor.generation);
  assert.equal(detail.client.attached, true);
  assert.equal(detail.client.canGetConnectionState, true);
  assert.equal(detail.client.canLogout, true);

  setActiveConnectionSupervisor(null);
  console.log('✅ Health real: live, ready, detail protegido e atividade da conexão verificados.');
}

try {
  run();
} catch (error) {
  console.error('❌ Teste do health da conexão falhou:', error?.stack || error?.message || error);
  process.exitCode = 1;
}
