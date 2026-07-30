'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');

for (const file of [
  'src/modules/fiscal/index.js',
  'src/modules/fiscal/server.js',
  'src/modules/fiscal/config.js',
  'src/modules/fiscal/db.js',
  'src/modules/fiscal/focusClient.js',
  'src/modules/fiscal/payloadBuilder.js',
  'public/fiscal/index.html',
  'public/fiscal/app.js',
  'src/services/fiscalModuleProcess.js',
]) assert.equal(fs.existsSync(path.join(root, file)), true, `arquivo fiscal ausente: ${file}`);

const config = fs.readFileSync(path.join(root, 'src/modules/fiscal/config.js'), 'utf8');
assert.match(config, /FISCAL_INTERNAL_PORT/);
assert.match(config, /FISCAL_DATA_DIRECTORY/);
assert.match(config, /PANEL_INTERNAL_SECRET/);

const server = fs.readFileSync(path.join(root, 'src/modules/fiscal/server.js'), 'utf8');
assert.match(server, /x-personalize-panel-secret/);

const panel = fs.readFileSync(path.join(root, 'src/services/unifiedPanelServer.js'), 'utf8');
assert.match(panel, /proxyFiscalRequest/);
assert.match(panel, /url.pathname === '\/fiscal'/);

const app = fs.readFileSync(path.join(root, 'public/panel/app.js'), 'utf8');
assert.match(app, /fiscal-frame/);
assert.equal(app.includes('/fiscal/?embedded=1'), true);

console.log('✅ Módulo fiscal completo integrado ao painel unificado.');
