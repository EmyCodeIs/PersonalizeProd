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
  'public/fiscal/standalonePaths.js',
  'scripts/migrate-fiscal-local.ps1',
  'scripts/check-focus-homologacao-real.js',
]) assert.equal(fs.existsSync(path.join(root, file)), true, `arquivo fiscal ausente: ${file}`);

for (const removedFile of [
  'src/modules/panel/server.js',
  'public/panel/index.html',
  'scripts/test-unified-panel.js',
  'src/modules/fiscal/process.js',
]) assert.equal(fs.existsSync(path.join(root, removedFile)), false, `arquivo fora do escopo ainda existe: ${removedFile}`);

process.env.DEMO_MODE = 'true';
process.env.ADMIN_NAME = 'Personalize';
process.env.ADMIN_EMAIL = 'fiscal@personalize.local';
process.env.ADMIN_PASSWORD = 'senha-local-segura';
process.env.SESSION_SECRET = '12345678901234567890123456789012';
process.env.FISCAL_HOST = '127.0.0.1';
process.env.FISCAL_PORT = '3031';
process.env.FISCAL_DATA_DIRECTORY = './data/fiscal';
process.env.FISCAL_DOCUMENT_DIRECTORY = './storage/fiscal-documents';

const { createConfig } = require('../src/modules/fiscal/config');
const fiscalConfig = createConfig();
assert.equal(fiscalConfig.host, '127.0.0.1');
assert.equal(fiscalConfig.port, 3031);
assert.equal(fiscalConfig.admin.email, 'fiscal@personalize.local');
assert.equal(fiscalConfig.admin.password, 'senha-local-segura');
assert.equal(fiscalConfig.sessionSecret, '12345678901234567890123456789012');
assert.equal(Object.hasOwn(fiscalConfig, 'panelTrustSecret'), false);
assert.equal(fiscalConfig.dataDirectory.endsWith(path.join('data', 'fiscal')), true);
assert.equal(fiscalConfig.documentDirectory.endsWith(path.join('storage', 'fiscal-documents')), true);

const startup = fs.readFileSync(path.join(root, 'src/start-with-required-labels.js'), 'utf8');
assert.equal(startup.includes("./modules/fiscal"), false, 'npm start não pode iniciar o fiscal');
assert.equal(startup.includes("./modules/panel"), false, 'npm start não pode iniciar painel novo');

const server = fs.readFileSync(path.join(root, 'src/modules/fiscal/server.js'), 'utf8');
assert.equal(server.includes("const cancelMatch = url.pathname.match(/^\\/api\\/invoices\\/(\\d+)\\/cancel$/);"), true);
assert.equal(server.includes("const documentMatch = url.pathname.match(/^\\/api\\/invoices\\/(\\d+)\\/(pdf|xml)$/);"), true);

const fiscalIndex = fs.readFileSync(path.join(root, 'public/fiscal/index.html'), 'utf8');
assert.equal(fiscalIndex.includes('href="/styles.css"'), true);
assert.equal(fiscalIndex.includes('src="/standalonePaths.js"'), true);
assert.equal(fiscalIndex.includes('embedded-navigation'), false);
assert.equal(fiscalIndex.includes('homologationCheck'), false);

const fiscalApp = fs.readFileSync(path.join(root, 'public/fiscal/app.js'), 'utf8');
assert.equal(fiscalApp.includes("link('#/notas','Notas fiscais','notes')"), true);
assert.equal(fiscalApp.includes("link('#/rascunhos','Rascunhos','drafts')"), true);

const standalonePaths = fs.readFileSync(path.join(root, 'public/fiscal/standalonePaths.js'), 'utf8');
assert.match(standalonePaths, /stripFiscalPrefix/);
assert.match(standalonePaths, /window\.fetch/);

const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
assert.equal(packageJson.scripts.start, 'node src/start-with-required-labels.js');
assert.equal(packageJson.scripts['fiscal:start'], 'node src/modules/fiscal/index.js');
assert.equal(packageJson.scripts['test:fiscal'], 'node scripts/test-fiscal-integration.js');
assert.equal(packageJson.scripts['fiscal:focus:check'], 'node scripts/check-focus-homologacao-real.js');
assert.equal(packageJson.scripts.test.includes('fiscal'), false, 'a suíte padrão do bot não deve depender do fiscal');
assert.equal(packageJson.scripts.test.includes('panel'), false, 'a suíte padrão do bot não deve depender de painel novo');

console.log('✅ Módulo fiscal isolado validado sem alterar inicialização, logs ou conexão do bot.');
