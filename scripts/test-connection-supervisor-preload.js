'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const originalCwd = process.cwd();
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'personalize-connection-preload-'));
process.chdir(tempDir);
process.env.WPP_WAIT_FOR_READY_BEFORE_CHANNEL_RETURN = 'false';
process.env.CONNECTION_EXIT_ON_FAILURE = 'false';

try {
  const preload = require('../src/core/connectionSupervisorPreload');
  const wppconnect = require('@wppconnect-team/wppconnect');
  const WppClient = require('../src/services/wppconnectClient');
  const QrAccess = require('../src/services/qrAccess');

  assert.equal(preload.connectionConfig.deviceSyncTimeoutMs, 180000);
  assert.equal(wppconnect.__personalizeConnectionCreatePatched, true);
  assert.equal(WppClient.__connectionSupervisorInstalled, true);

  QrAccess.publishConnected('SYNCING');
  let snapshot = JSON.parse(
    fs.readFileSync(path.join(tempDir, 'data', 'qr-status', 'status.json'), 'utf8'),
  );
  assert.equal(snapshot.status, 'waiting');
  assert.equal(snapshot.connectionState, 'SYNCING');

  QrAccess.publishConnected('DISCONNECTED');
  snapshot = JSON.parse(
    fs.readFileSync(path.join(tempDir, 'data', 'qr-status', 'status.json'), 'utf8'),
  );
  assert.notEqual(snapshot.status, 'connected');
  assert.equal(snapshot.connectionState, 'DISCONNECTED');

  QrAccess.publishConnected('CONNECTED');
  snapshot = JSON.parse(
    fs.readFileSync(path.join(tempDir, 'data', 'qr-status', 'status.json'), 'utf8'),
  );
  assert.equal(snapshot.status, 'connected');
  assert.equal(snapshot.connectionState, 'CONNECTED');

  console.log('✅ Preload da conexão: timeout finito instalado e painel só conecta em CONNECTED.');
} catch (error) {
  console.error('❌ Teste do preload da conexão falhou:', error?.stack || error?.message || error);
  process.exitCode = 1;
} finally {
  process.chdir(originalCwd);
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
}
