'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readConnectionSnapshot } = require('../src/modules/panel/server');

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

  const panelRoot = path.resolve(__dirname, '..', 'public', 'panel');
  const indexHtml = fs.readFileSync(path.join(panelRoot, 'index.html'), 'utf8');
  const connectionScript = fs.readFileSync(path.join(panelRoot, 'connection-visual.js'), 'utf8');
  const connectionStyles = fs.readFileSync(path.join(panelRoot, 'connection-visual.css'), 'utf8');

  assert.match(indexHtml, /connection-visual\.css/);
  assert.match(indexHtml, /connection-visual\.js/);
  assert.match(connectionScript, /Escaneie para entrar/);
  assert.match(connectionScript, /Número de telefone/);
  assert.match(connectionScript, /data-action="refresh-connection"/);
  assert.match(connectionScript, /MutationObserver/);
  assert.match(connectionStyles, /\.connection-whatsapp-card/);
  assert.match(connectionStyles, /\.connection-refresh-control/);
  assert.match(connectionStyles, /\.connection-pairing-code/);

  console.log('Painel unificado: leitura de status e padrão visual da conexão validados.');
} finally {
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
}
