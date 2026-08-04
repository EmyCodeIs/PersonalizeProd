'use strict';

const assert = require('assert/strict');
const {
  ConnectionSupervisor,
  STATES,
  normalizeRawState,
} = require('../src/services/connectionSupervisor');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const logger = { log() {}, warn() {}, error() {} };

function baseConfig(overrides = {}) {
  return {
    syncTimeoutMs: 1000,
    probeTimeoutMs: 100,
    recoveryActionTimeoutMs: 100,
    recoveryDelayMs: 1,
    recoveryCooldownMs: 50,
    maxRecoveryAttempts: 3,
    exitOnFailure: false,
    exitDelayMs: 1000,
    ...overrides,
  };
}

function fakeClient(initialState = 'SYNCING') {
  let state = initialState;
  const listeners = [];
  let watchdogCalls = 0;
  const client = {
    page: {
      async reload() { return true; },
    },
    onStateChange(callback) { listeners.push(callback); },
    async getConnectionState() { return state; },
    async isConnected() { return state === 'CONNECTED'; },
    async isMainReady() { return state === 'CONNECTED'; },
    async startPhoneWatchdog() {
      watchdogCalls += 1;
      state = 'CONNECTED';
      return true;
    },
    emit(next) {
      state = next;
      for (const listener of listeners) listener(next);
    },
    get state() { return state; },
    get watchdogCalls() { return watchdogCalls; },
  };
  return client;
}

async function testReadinessAndGeneration() {
  const supervisor = new ConnectionSupervisor({ config: baseConfig(), logger });
  const generation1 = supervisor.beginGeneration('test');
  const client1 = fakeClient('SYNCING');
  supervisor.attachClient(client1, generation1);

  client1.emit('SYNCING');
  assert.equal(supervisor.state, STATES.SYNCING);
  assert.equal(supervisor.isReady(), false);

  client1.emit('RESUMING');
  assert.equal(supervisor.state, STATES.SYNCING);
  assert.equal(supervisor.isReady(), false);

  client1.emit('INCHAT');
  assert.equal(supervisor.isReady(), false, 'INCHAT não pode substituir CONNECTED');

  client1.emit('CONNECTED');
  assert.equal(supervisor.state, STATES.READY);
  assert.equal(supervisor.isReady(), true);
  assert.ok(supervisor.snapshot().lastReadyAt);

  const generation2 = supervisor.beginGeneration('replace-client');
  assert.equal(generation2, generation1 + 1);
  client1.emit('DISCONNECTED');
  assert.equal(
    supervisor.state,
    STATES.STARTING,
    'listener da geração anterior não pode alterar a conexão atual',
  );

  const client2 = fakeClient('PAIRING');
  supervisor.attachClient(client2, generation2);
  client2.emit('PAIRING');
  await sleep(20);
  assert.equal(supervisor.state, STATES.WAITING_QR);
  assert.equal(supervisor.recoveryAttempts, 0, 'QR não pode disparar reinício automático');

  supervisor.dispose();
}

async function testSyncTimeoutRecovery() {
  const supervisor = new ConnectionSupervisor({
    config: baseConfig({ syncTimeoutMs: 20, recoveryCooldownMs: 10 }),
    logger,
  });
  const generation = supervisor.beginGeneration('sync-timeout');
  const client = fakeClient('SYNCING');
  supervisor.attachClient(client, generation);
  client.emit('SYNCING');

  await sleep(80);
  assert.equal(client.watchdogCalls, 1, 'primeiro nível deve acionar o watchdog oficial');
  assert.equal(supervisor.state, STATES.READY);
  assert.equal(supervisor.isReady(), true);
  assert.equal(supervisor.recoveryAttempts, 0, 'READY deve zerar as tentativas');

  supervisor.dispose();
}

function testControlledExitAndNormalization() {
  let exitCode = null;
  const supervisor = new ConnectionSupervisor({
    config: baseConfig({ exitOnFailure: true, exitDelayMs: 1000 }),
    logger,
    exitProcess: (code) => { exitCode = code; },
  });
  supervisor.beginGeneration('failure');
  const result = supervisor.failAndMaybeExit('test_failure', 3);

  assert.equal(result.exitRequested, true);
  assert.equal(supervisor.state, STATES.FAILED);
  assert.equal(supervisor.snapshot().exitRequested, true);
  assert.equal(exitCode, null, 'reinício precisa respeitar o atraso controlado');
  assert.equal(normalizeRawState('phone-not-connected'), 'PHONE_NOT_CONNECTED');

  supervisor.dispose();
}

async function run() {
  await testReadinessAndGeneration();
  await testSyncTimeoutRecovery();
  testControlledExitAndNormalization();
  console.log('✅ ConnectionSupervisor: READY estrito, gerações, QR, timeout e recuperação verificados.');
}

run().catch((error) => {
  console.error('❌ Teste do ConnectionSupervisor falhou:', error?.stack || error?.message || error);
  process.exitCode = 1;
});
