'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readConnectionSnapshot } = require('../src/services/unifiedPanelServer');

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'personalize-panel-'));
const statusPath = path.join(temporaryDirectory, 'status.json');

try {
  const missing = readConnectionSnapshot(statusPath);
  assert.equal(missing.status, 'waiting');
  assert.equal(missing.connectionState, 'SEM SINAL');

  fs.writeFileSync(statusPath, JSON.stringify({
    status: 'qr',
    connectionState: 'PAIRING',
    attempts: 2,
    pairingCode: 'ABCD1234',
    imageSrc: 'data:image/png;base64,AAA',
    updatedAt: '2026-07-30T12:00:00.000Z',
  }));

  const snapshot = readConnectionSnapshot(statusPath);
  assert.equal(snapshot.status, 'qr');
  assert.equal(snapshot.connectionState, 'PAIRING');
  assert.equal(snapshot.attempts, 2);
  assert.equal(snapshot.pairingCode, 'ABCD1234');
  assert.match(snapshot.imageSrc, /^data:image\/png/);

  console.log('Painel unificado: leitura de status validada.');
} finally {
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
}
