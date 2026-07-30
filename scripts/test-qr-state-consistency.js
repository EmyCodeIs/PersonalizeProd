'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const originalCwd = process.cwd();
const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'personalize-qr-state-'));
const qrAccessPath = require.resolve('../src/services/qrAccess');
const preloadPath = require.resolve('../src/core/qrStateConsistencyPreload');

function readSnapshot() {
  return JSON.parse(fs.readFileSync(path.join(temporaryDirectory, 'data', 'qr-status', 'status.json'), 'utf8'));
}

try {
  process.chdir(temporaryDirectory);
  delete require.cache[qrAccessPath];
  delete require.cache[preloadPath];

  const QrAccess = require(qrAccessPath);
  require(preloadPath);

  QrAccess.publishQrCode({
    base64Qr: 'data:image/png;base64,AAA',
    attempts: 1,
    urlCode: 'codigo-qr-real',
    connectionState: 'PAIRING',
  });

  let snapshot = readSnapshot();
  assert.equal(snapshot.status, 'qr');
  assert.match(snapshot.imageSrc, /^data:image\/png/);

  QrAccess.publishState('notLogged', 'Status do WPPConnect: notLogged');
  snapshot = readSnapshot();
  assert.equal(snapshot.status, 'qr', 'notLogged não pode esconder um QR recém-publicado');
  assert.match(snapshot.imageSrc, /^data:image\/png/);

  QrAccess.publishState('qrReadFail', 'Status do WPPConnect: qrReadFail');
  snapshot = readSnapshot();
  assert.equal(snapshot.status, 'qr', 'qrReadFail transitório precisa manter o QR ativo');

  QrAccess.publishState('isLogged', 'Status do WPPConnect: isLogged');
  snapshot = readSnapshot();
  assert.equal(snapshot.status, 'connected');
  assert.equal(snapshot.connectionState, 'ISLOGGED');

  QrAccess.publishQrCode({
    base64Qr: 'data:image/png;base64,BBB',
    attempts: 2,
    connectionState: 'PAIRING',
  });
  QrAccess.publishState('desconnectedMobile', 'Status do WPPConnect: desconnectedMobile');
  snapshot = readSnapshot();
  assert.equal(snapshot.status, 'waiting');
  assert.equal(snapshot.connectionState, 'DISCONNECTEDMOBILE');
  assert.equal(snapshot.disconnectState, 'DISCONNECTEDMOBILE');

  console.log('✅ QR preservado durante notLogged/qrReadFail e liberado em conexão ou desconexão real.');
} finally {
  process.chdir(originalCwd);
  delete require.cache[qrAccessPath];
  delete require.cache[preloadPath];
  fs.rmSync(temporaryDirectory, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
}
