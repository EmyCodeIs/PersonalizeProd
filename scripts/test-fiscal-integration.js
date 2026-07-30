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
  'src/modules/fiscal/process.js',
  'src/modules/panel/server.js',
  'public/panel/index.html',
  'public/panel/app.js',
  'public/panel/styles.css',
  'public/fiscal/index.html',
  'public/fiscal/app.js',
  'public/fiscal/standalonePaths.js',
  'public/fiscal/embedded-navigation.css',
  'public/fiscal/homologationCheck.js',
  'scripts/migrate-fiscal-local.ps1',
  'scripts/check-focus-homologacao-real.js',
]) assert.equal(fs.existsSync(path.join(root, file)), true, `arquivo fiscal ou de integração ausente: ${file}`);

process.env.DEMO_MODE = 'true';
process.env.PANEL_ADMIN_NAME = 'Personalize';
process.env.PANEL_ADMIN_EMAIL = 'painel@personalize.local';
process.env.PANEL_ADMIN_PASSWORD = 'senha-local-segura';
process.env.PANEL_SESSION_SECRET = '12345678901234567890123456789012';
process.env.PANEL_INTERNAL_SECRET = 'segredo-interno-do-painel-fiscal';
process.env.FISCAL_INTERNAL_HOST = '127.0.0.1';
process.env.FISCAL_INTERNAL_PORT = '3031';
process.env.FISCAL_DATA_DIRECTORY = './data/fiscal';
process.env.FISCAL_DOCUMENT_DIRECTORY = './storage/fiscal-documents';

const { createConfig } = require('../src/modules/fiscal/config');
const fiscalConfig = createConfig();
assert.equal(fiscalConfig.host, '127.0.0.1');
assert.equal(fiscalConfig.port, 3031);
assert.equal(fiscalConfig.admin.email, 'painel@personalize.local');
assert.equal(fiscalConfig.admin.password, 'senha-local-segura');
assert.equal(fiscalConfig.sessionSecret, '12345678901234567890123456789012');
assert.equal(fiscalConfig.panelTrustSecret, 'segredo-interno-do-painel-fiscal');
assert.equal(fiscalConfig.dataDirectory.endsWith(path.join('data', 'fiscal')), true);
assert.equal(fiscalConfig.documentDirectory.endsWith(path.join('storage', 'fiscal-documents')), true);

const startup = fs.readFileSync(path.join(root, 'src/start-with-required-labels.js'), 'utf8');
assert.match(startup, /startFiscalModuleProcess/);
assert.match(startup, /startUnifiedPanelServer/);
assert.match(startup, /handoffSleepPreload/);

const server = fs.readFileSync(path.join(root, 'src/modules/fiscal/server.js'), 'utf8');
assert.match(server, /x-personalize-panel-secret/);
assert.equal(server.includes("const cancelMatch = url.pathname.match(/^\\/api\\/invoices\\/(\\d+)\\/cancel$/);"), true);
assert.equal(server.includes("const documentMatch = url.pathname.match(/^\\/api\\/invoices\\/(\\d+)\\/(pdf|xml)$/);"), true);

const panel = fs.readFileSync(path.join(root, 'src/modules/panel/server.js'), 'utf8');
assert.match(panel, /proxyFiscalRequest/);
assert.match(panel, /url\.pathname === '\/fiscal'/);
assert.match(panel, /isFocusWebhook/);
assert.match(panel, /fiscalMigrationState: 'integrado'/);

const panelApp = fs.readFileSync(path.join(root, 'public/panel/app.js'), 'utf8');
assert.match(panelApp, /fiscal-frame/);
assert.equal(panelApp.includes('/fiscal/?embedded=1'), true);

const fiscalIndex = fs.readFileSync(path.join(root, 'public/fiscal/index.html'), 'utf8');
assert.equal(fiscalIndex.includes('embedded-navigation.css'), true);
assert.equal(fiscalIndex.includes('homologationCheck.js'), true);
assert.equal(fiscalIndex.includes('standalonePaths.js'), true);

const fiscalApp = fs.readFileSync(path.join(root, 'public/fiscal/app.js'), 'utf8');
assert.equal(fiscalApp.includes('/fiscal/api/'), true);
assert.equal(/(['"`])\/api\//.test(fiscalApp), false, 'a interface fiscal não pode escapar do proxy /fiscal');
assert.equal(fiscalApp.includes("link('#/notas','Notas fiscais','notes')"), true);
assert.equal(fiscalApp.includes("link('#/rascunhos','Rascunhos','drafts')"), true);

const standalonePaths = fs.readFileSync(path.join(root, 'public/fiscal/standalonePaths.js'), 'utf8');
assert.match(standalonePaths, /if \(embedded\) return/);
assert.match(standalonePaths, /stripFiscalPrefix/);

const embeddedNavigation = fs.readFileSync(path.join(root, 'public/fiscal/embedded-navigation.css'), 'utf8');
assert.match(embeddedNavigation, /html\.fiscal-embedded \.sidebar/);
assert.match(embeddedNavigation, /\.sidebar-nav/);

const homologationCheck = fs.readFileSync(path.join(root, 'public/fiscal/homologationCheck.js'), 'utf8');
assert.match(homologationCheck, /DEMO_MODE=false/);
assert.match(homologationCheck, /lookup\/cnpj/);

const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
assert.match(packageJson.scripts.test, /test:fiscal-integration/);
assert.match(packageJson.scripts.test, /test:unified-panel/);
assert.equal(packageJson.scripts['fiscal:start'], 'node src/modules/fiscal/index.js');
assert.equal(packageJson.scripts['fiscal:focus:check'], 'node scripts/check-focus-homologacao-real.js');
assert.equal(packageJson.scripts['test:seller-label-migration'], 'node scripts/test-seller-label-migration.js');

console.log('✅ Bot atual preservado com painel unificado conectado e módulo fiscal completo.');
