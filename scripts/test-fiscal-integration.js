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
  'scripts/migrate-fiscal-local.ps1',
]) assert.equal(fs.existsSync(path.join(root, file)), true, `arquivo fiscal ausente: ${file}`);

process.env.DEMO_MODE = 'true';
process.env.PANEL_ADMIN_NAME = 'Personalize';
process.env.PANEL_ADMIN_EMAIL = 'painel@personalize.local';
process.env.PANEL_ADMIN_PASSWORD = 'senha-local-segura';
process.env.PANEL_SESSION_SECRET = '12345678901234567890123456789012';
process.env.PANEL_INTERNAL_SECRET = 'segredo-interno-do-painel-fiscal';
process.env.FISCAL_INTERNAL_PORT = '3031';
process.env.FISCAL_DATA_DIRECTORY = './data/fiscal';
process.env.FISCAL_DOCUMENT_DIRECTORY = './storage/fiscal-documents';

const { createConfig } = require('../src/modules/fiscal/config');
const fiscalConfig = createConfig();
assert.equal(fiscalConfig.port, 3031);
assert.equal(fiscalConfig.admin.email, 'painel@personalize.local');
assert.equal(fiscalConfig.admin.password, 'senha-local-segura');
assert.equal(fiscalConfig.sessionSecret, '12345678901234567890123456789012');
assert.equal(fiscalConfig.panelTrustSecret, 'segredo-interno-do-painel-fiscal');
assert.equal(fiscalConfig.dataDirectory.endsWith(path.join('data', 'fiscal')), true);
assert.equal(fiscalConfig.documentDirectory.endsWith(path.join('storage', 'fiscal-documents')), true);

const server = fs.readFileSync(path.join(root, 'src/modules/fiscal/server.js'), 'utf8');
assert.match(server, /x-personalize-panel-secret/);
assert.match(server, /\/api\/invoices\/\(\\d\+\)\/cancel/);
assert.match(server, /\/api\/invoices\/\(\\d\+\)\/\(pdf\|xml\)/);

const panel = fs.readFileSync(path.join(root, 'src/services/unifiedPanelServer.js'), 'utf8');
assert.match(panel, /proxyFiscalRequest/);
assert.match(panel, /url\.pathname === '\/fiscal'/);
assert.match(panel, /isFocusWebhook/);
assert.match(panel, /fiscalMigrationState: 'integrado'/);

const panelApp = fs.readFileSync(path.join(root, 'public/panel/app.js'), 'utf8');
assert.match(panelApp, /fiscal-frame/);
assert.equal(panelApp.includes('/fiscal/?embedded=1'), true);

const fiscalIndex = fs.readFileSync(path.join(root, 'public/fiscal/index.html'), 'utf8');
assert.equal(fiscalIndex.includes('href="/fiscal/'), true);
assert.equal(fiscalIndex.includes('src="/fiscal/'), true);

const fiscalApp = fs.readFileSync(path.join(root, 'public/fiscal/app.js'), 'utf8');
assert.equal(fiscalApp.includes('/fiscal/api/'), true);
assert.equal(/(['"`])\/api\//.test(fiscalApp), false, 'a interface fiscal não pode escapar do proxy /fiscal');

const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
assert.match(packageJson.scripts.test, /test:fiscal-integration/);

console.log('✅ Módulo fiscal completo integrado ao painel unificado.');
