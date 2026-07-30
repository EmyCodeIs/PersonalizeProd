import fs from 'node:fs';
import path from 'node:path';

const sourceRoot = path.resolve(process.argv[2] || '');
const projectRoot = process.cwd();

if (!sourceRoot || !fs.existsSync(path.join(sourceRoot, 'src', 'server.js'))) {
  throw new Error('Informe a pasta clonada do PersonalizeNF como primeiro argumento.');
}

function ensureDir(target) {
  fs.mkdirSync(target, { recursive: true });
}

function read(target) {
  return fs.readFileSync(target, 'utf8');
}

function write(target, content) {
  ensureDir(path.dirname(target));
  fs.writeFileSync(target, content.replace(/\r\n/g, '\n'));
}

function replaceRequired(content, search, replacement, label) {
  if (!content.includes(search)) throw new Error(`Trecho não encontrado ao adaptar ${label}.`);
  return content.replace(search, replacement);
}

const fiscalSource = path.join(projectRoot, 'src', 'modules', 'fiscal');
const fiscalPublic = path.join(projectRoot, 'public', 'fiscal');
fs.rmSync(fiscalSource, { recursive: true, force: true });
fs.rmSync(fiscalPublic, { recursive: true, force: true });
ensureDir(fiscalSource);
ensureDir(fiscalPublic);

for (const filename of fs.readdirSync(path.join(sourceRoot, 'src'))) {
  if (!filename.endsWith('.js')) continue;
  fs.copyFileSync(path.join(sourceRoot, 'src', filename), path.join(fiscalSource, filename));
}

for (const filename of fs.readdirSync(path.join(sourceRoot, 'public'))) {
  const source = path.join(sourceRoot, 'public', filename);
  if (!fs.statSync(source).isFile()) continue;
  fs.copyFileSync(source, path.join(fiscalPublic, filename));
}

let config = read(path.join(fiscalSource, 'config.js'));
config = replaceRequired(config, "host: process.env.HOST || '127.0.0.1',", "host: process.env.FISCAL_INTERNAL_HOST || '127.0.0.1',", 'config.host');
config = replaceRequired(config, 'port: number(process.env.PORT, 3030),', 'port: number(process.env.FISCAL_INTERNAL_PORT, 3031),', 'config.port');
config = replaceRequired(config, "appName: process.env.APP_NAME || 'Personalize NF',", "appName: process.env.FISCAL_APP_NAME || 'Personalize NF',", 'config.appName');
config = replaceRequired(config, "dataDirectory: path.resolve(root, process.env.DATA_DIRECTORY || './data'),", "dataDirectory: path.resolve(root, process.env.FISCAL_DATA_DIRECTORY || './data/fiscal'),", 'config.dataDirectory');
config = replaceRequired(config, "documentDirectory: path.resolve(root, process.env.DOCUMENT_DIRECTORY || './storage/documents'),", "documentDirectory: path.resolve(root, process.env.FISCAL_DOCUMENT_DIRECTORY || './storage/fiscal-documents'),", 'config.documentDirectory');
config = replaceRequired(config, "publicDirectory: path.resolve(root, './public'),", "publicDirectory: path.resolve(root, './public/fiscal'),", 'config.publicDirectory');
config = replaceRequired(config, '    runtimeMode,\n    demoApprovalDelayMs:', "    runtimeMode,\n    panelTrustSecret: text(process.env.PANEL_INTERNAL_SECRET),\n    demoApprovalDelayMs:", 'config.panelTrustSecret');
write(path.join(fiscalSource, 'config.js'), config);

let server = read(path.join(fiscalSource, 'server.js'));
const authenticateOriginal = `  function authenticate(req) {\n    const token = parseCookies(req.headers.cookie || '')[cookieName];\n    if (!token) return null;`;
const authenticateIntegrated = `  function authenticate(req) {\n    const trustedSecret = req.headers['x-personalize-panel-secret'];\n    if (config.panelTrustSecret && safeSecretEquals(trustedSecret, config.panelTrustSecret)) {\n      const trustedUser = db.prepare('SELECT id,name,email,role,active FROM users WHERE email=? AND active=1 LIMIT 1').get(config.admin.email);\n      if (trustedUser) return trustedUser;\n    }\n\n    const token = parseCookies(req.headers.cookie || '')[cookieName];\n    if (!token) return null;`;
server = replaceRequired(server, authenticateOriginal, authenticateIntegrated, 'server.authenticate');
server = server.replace(/frame-ancestors 'none'/g, "frame-ancestors 'self'");
write(path.join(fiscalSource, 'server.js'), server);

let fiscalIndex = read(path.join(fiscalPublic, 'index.html'));
fiscalIndex = fiscalIndex
  .replace(/(href|src)="\/(?!fiscal\/)/g, '$1="/fiscal/')
  .replace('<meta name="viewport" content="width=device-width, initial-scale=1.0" />', '<meta name="viewport" content="width=device-width, initial-scale=1.0" />\n  <meta name="robots" content="noindex,nofollow" />');
write(path.join(fiscalPublic, 'index.html'), fiscalIndex);

for (const filename of ['app.js', 'environmentBadge.js', 'formEnhancements.js']) {
  const target = path.join(fiscalPublic, filename);
  if (!fs.existsSync(target)) continue;
  let content = read(target)
    .replace(/(['"`])\/api\//g, '$1/fiscal/api/')
    .replace(/(['"`])\/api(['"`])/g, '$1/fiscal/api$2');
  if (filename === 'app.js') {
    content = `'use strict';\n\nif (window.self !== window.top || new URLSearchParams(window.location.search).get('embedded') === '1') {\n  document.documentElement.classList.add('fiscal-embedded');\n}\n\n` + content.replace(/^'use strict';\s*/, '');
  }
  write(target, content);
}

const embeddedCss = `\n\n/* Integração no painel unificado */\nhtml.fiscal-embedded body { background: #f4f4f2; }\nhtml.fiscal-embedded .sidebar { display: none !important; }\nhtml.fiscal-embedded .app-shell { grid-template-columns: minmax(0, 1fr) !important; }\nhtml.fiscal-embedded .main { min-width: 0; margin: 0 !important; }\nhtml.fiscal-embedded .topbar { top: 0; }\nhtml.fiscal-embedded .mobile-nav { display: none !important; }\nhtml.fiscal-embedded .content { width: 100%; max-width: none; padding-top: 24px; }\nhtml.fiscal-embedded .login-shell { min-height: 100vh; }\n`;
for (const filename of ['styles.css', 'personalize-theme.css']) {
  const target = path.join(fiscalPublic, filename);
  if (fs.existsSync(target)) write(target, read(target) + embeddedCss);
}

const fiscalProcess = `'use strict';\n\nconst crypto = require('node:crypto');\nconst path = require('node:path');\nconst { fork } = require('node:child_process');\n\nlet child = null;\nlet stopping = false;\nlet restartTimer = null;\n\nfunction enabled() {\n  return !/^(0|false|no|nao|off)$/i.test(String(process.env.FISCAL_MODULE_ENABLED || 'true').trim());\n}\n\nfunction startFiscalModuleProcess() {\n  if (!enabled()) {\n    console.log('[FISCAL] módulo fiscal desativado por FISCAL_MODULE_ENABLED=false');\n    return null;\n  }\n  if (child) return child;\n\n  const secret = String(process.env.PANEL_INTERNAL_SECRET || crypto.randomBytes(32).toString('hex'));\n  process.env.PANEL_INTERNAL_SECRET = secret;\n  const entry = path.resolve(process.cwd(), 'src', 'modules', 'fiscal', 'index.js');\n  const env = {\n    ...process.env,\n    PANEL_INTERNAL_SECRET: secret,\n    FISCAL_INTERNAL_HOST: process.env.FISCAL_INTERNAL_HOST || '127.0.0.1',\n    FISCAL_INTERNAL_PORT: process.env.FISCAL_INTERNAL_PORT || '3031',\n    FISCAL_DATA_DIRECTORY: process.env.FISCAL_DATA_DIRECTORY || './data/fiscal',\n    FISCAL_DOCUMENT_DIRECTORY: process.env.FISCAL_DOCUMENT_DIRECTORY || './storage/fiscal-documents',\n  };\n\n  child = fork(entry, [], { cwd: process.cwd(), env, stdio: 'inherit' });\n  child.once('exit', (code, signal) => {\n    child = null;\n    if (stopping) return;\n    console.warn(\`[FISCAL] processo encerrado | código=\${code ?? '-'} | sinal=\${signal || '-'}\`);\n    restartTimer = setTimeout(() => {\n      restartTimer = null;\n      startFiscalModuleProcess();\n    }, 5000);\n    restartTimer.unref?.();\n  });\n  child.once('error', (error) => console.warn('[FISCAL] falha isolada:', error?.message || error));\n  console.log(\`[FISCAL] módulo iniciado internamente em http://\${env.FISCAL_INTERNAL_HOST}:\${env.FISCAL_INTERNAL_PORT}\`);\n  return child;\n}\n\nfunction stopFiscalModuleProcess() {\n  stopping = true;\n  if (restartTimer) clearTimeout(restartTimer);\n  if (child && !child.killed) child.kill('SIGTERM');\n}\n\nprocess.once('SIGINT', stopFiscalModuleProcess);\nprocess.once('SIGTERM', stopFiscalModuleProcess);\n\nmodule.exports = { startFiscalModuleProcess, stopFiscalModuleProcess };\n`;
write(path.join(projectRoot, 'src', 'services', 'fiscalModuleProcess.js'), fiscalProcess);

let panelServer = read(path.join(projectRoot, 'src', 'services', 'unifiedPanelServer.js'));
const proxyFunction = `\nfunction proxyFiscalRequest({ request, response, url, config }) {\n  const targetPath = (url.pathname.replace(/^\\/fiscal(?=\\/|$)/, '') || '/') + url.search;\n  const headers = {\n    ...request.headers,\n    host: \`${'${config.fiscalInternalHost}:${config.fiscalInternalPort}'}\`,\n    'x-personalize-panel-secret': config.panelInternalSecret,\n  };\n  delete headers.connection;\n\n  const upstream = http.request({\n    host: config.fiscalInternalHost,\n    port: config.fiscalInternalPort,\n    path: targetPath,\n    method: request.method,\n    headers,\n    timeout: 65000,\n  }, (upstreamResponse) => {\n    const responseHeaders = { ...upstreamResponse.headers };\n    if (typeof responseHeaders.location === 'string' && responseHeaders.location.startsWith('/')) {\n      responseHeaders.location = \`/fiscal\${responseHeaders.location}\`;\n    }\n    response.writeHead(upstreamResponse.statusCode || 502, responseHeaders);\n    upstreamResponse.pipe(response);\n  });\n\n  upstream.on('timeout', () => upstream.destroy(new Error('O módulo fiscal demorou para responder.')));\n  upstream.on('error', (error) => {\n    if (!response.headersSent) json(response, 502, { error: \`Módulo fiscal indisponível: \${error.message}\` });\n    else response.destroy(error);\n  });\n  request.pipe(upstream);\n}\n`;
panelServer = replaceRequired(panelServer, '\nfunction createPanelConfig() {', `${proxyFunction}\nfunction createPanelConfig() {`, 'panel.proxy');
panelServer = replaceRequired(panelServer,
  "    fiscalPanelUrl: String(process.env.FISCAL_PANEL_URL || '').trim(),\n    fiscalMigrationState: String(process.env.FISCAL_MIGRATION_STATE || 'preparando').trim(),",
  "    panelInternalSecret: String(process.env.PANEL_INTERNAL_SECRET || '').trim(),\n    fiscalInternalHost: String(process.env.FISCAL_INTERNAL_HOST || '127.0.0.1').trim(),\n    fiscalInternalPort: Math.max(1, number(process.env.FISCAL_INTERNAL_PORT, 3031)),\n    fiscalPanelUrl: '/fiscal/',\n    fiscalMigrationState: 'integrado',",
  'panel.config.fiscal');
panelServer = replaceRequired(panelServer,
  "    if (url.pathname.startsWith('/api/')) {",
  "    if (url.pathname === '/fiscal' || url.pathname.startsWith('/fiscal/')) {\n      if (!session) return json(response, 401, { error: 'Faça login para continuar.' });\n      if (!config.panelInternalSecret) return json(response, 503, { error: 'Integração fiscal interna não configurada.' });\n      proxyFiscalRequest({ request, response, url, config });\n      return;\n    }\n\n    if (url.pathname.startsWith('/api/')) {",
  'panel.handler.fiscal');
panelServer = panelServer.replace("console.log('[PAINEL] módulos iniciais: visão geral e conexão do bot');", "console.log('[PAINEL] módulos integrados: conexão do bot e notas fiscais');");
write(path.join(projectRoot, 'src', 'services', 'unifiedPanelServer.js'), panelServer);

let panelApp = read(path.join(projectRoot, 'public', 'panel', 'app.js'));
panelApp = panelApp
  .replace("<div class=\"metric-foot\">Estrutura fiscal preservada separadamente</div>", "<div class=\"metric-foot\">Emissão, documentos e histórico no mesmo painel</div>")
  .replace("const fiscalState = data.fiscal?.migrationState || 'preparando';", "const fiscalState = data.fiscal?.migrationState || 'integrado';");
const fiscalStart = panelApp.indexOf('async function fiscalView() {');
const routeStart = panelApp.indexOf('\nasync function route() {', fiscalStart);
if (fiscalStart < 0 || routeStart < 0) throw new Error('Função fiscalView não encontrada no painel.');
const fiscalView = `async function fiscalView() {\n  app.innerHTML = shell(\`<section class="fiscal-frame-card">\n    <iframe class="fiscal-frame" src="/fiscal/?embedded=1" title="Emissão e gestão de notas fiscais" loading="eager"></iframe>\n  </section>\`, 'Notas fiscais');\n  bindShell();\n  stopPolling();\n}\n`;
panelApp = panelApp.slice(0, fiscalStart) + fiscalView + panelApp.slice(routeStart + 1);
write(path.join(projectRoot, 'public', 'panel', 'app.js'), panelApp);

const panelStylesPath = path.join(projectRoot, 'public', 'panel', 'styles.css');
write(panelStylesPath, read(panelStylesPath) + `\n\n/* Módulo fiscal integrado */\n.fiscal-frame-card { height: calc(100vh - 116px); min-height: 680px; overflow: hidden; border: 1px solid var(--line); border-radius: 18px; background: #fff; box-shadow: var(--shadow); }\n.fiscal-frame { width: 100%; height: 100%; display: block; border: 0; background: var(--canvas); }\n@media (max-width: 760px) { .fiscal-frame-card { height: calc(100vh - 140px); min-height: 620px; border-radius: 12px; } }\n`);

let starter = read(path.join(projectRoot, 'src', 'start-with-required-labels.js'));
starter = replaceRequired(starter,
  "const { startUnifiedPanelServer } = require('./services/unifiedPanelServer');",
  "const { startFiscalModuleProcess } = require('./services/fiscalModuleProcess');\nconst { startUnifiedPanelServer } = require('./services/unifiedPanelServer');",
  'startup.import');
starter = replaceRequired(starter,
  "// O painel usa apenas APIs locais e arquivos de status. Qualquer falha de porta,\n// senha ou configuração é isolada e nunca impede o atendimento do bot.\ntry {\n  startUnifiedPanelServer();",
  "// O fiscal roda em processo isolado: qualquer falha da Focus ou do banco fiscal\n// não encerra nem bloqueia o atendimento do WhatsApp.\ntry {\n  startFiscalModuleProcess();\n} catch (error) {\n  console.warn('[FISCAL] falha isolada ao iniciar:', error?.message || error);\n}\n\n// O painel usa somente APIs locais. Falhas visuais nunca impedem o bot.\ntry {\n  startUnifiedPanelServer();",
  'startup.fiscal');
write(path.join(projectRoot, 'src', 'start-with-required-labels.js'), starter);

const envPath = path.join(projectRoot, '.env.example');
let env = read(envPath);
const fiscalEnvBlock = `\n\n# ============================================================\n# PAINEL UNIFICADO E MÓDULO FISCAL\n# ============================================================\nUNIFIED_PANEL_ENABLED=true\nPANEL_HOST=127.0.0.1\nPANEL_PORT=3030\nPANEL_ADMIN_EMAIL=contato@personalizeseuambiente.com.br\nPANEL_ADMIN_PASSWORD=troque-por-uma-senha-forte\nPANEL_SESSION_SECRET=troque-por-uma-chave-com-32-caracteres-ou-mais\nFISCAL_MODULE_ENABLED=true\nFISCAL_INTERNAL_HOST=127.0.0.1\nFISCAL_INTERNAL_PORT=3031\nFISCAL_DATA_DIRECTORY=./data/fiscal\nFISCAL_DOCUMENT_DIRECTORY=./storage/fiscal-documents\n\n# Demonstração local: não chama a Focus e gera PDF/XML sem validade fiscal.\nDEMO_MODE=true\nDEMO_APPROVAL_DELAY_MS=1800\nALLOW_PRODUCTION=false\nFOCUS_ENVIRONMENT=homologacao\nFOCUS_TOKEN_HOMOLOGACAO=\nFOCUS_TOKEN_PRODUCAO=\nFOCUS_REQUEST_TIMEOUT_MS=30000\nFOCUS_DOCUMENT_TIMEOUT_MS=60000\nFOCUS_POLL_INTERVAL_MS=5000\nFOCUS_WEBHOOK_SECRET=\nDPS_SERIES_HOMOLOGACAO=1\nDPS_SERIES_PRODUCAO=1\nCOMPANY_CNPJ=18342858000108\nCOMPANY_NAME=PERSONALIZE ADESIVOS DECORATIVOS LTDA\nCOMPANY_TRADE_NAME=Personalize Seu Ambiente\nCOMPANY_MUNICIPAL_REGISTRATION=04913840010\nCOMPANY_SEND_MUNICIPAL_REGISTRATION=true\nCOMPANY_STATE_REGISTRATION=0021708330062\nCOMPANY_CITY_CODE=3106200\nCOMPANY_CITY=Belo Horizonte\nCOMPANY_STATE=MG\nCOMPANY_SIMPLE_OPTION=3\nCOMPANY_SIMPLE_REGIME=1\nCOMPANY_SPECIAL_TAX_REGIME=0\nCOMPANY_APPROX_TAX_PERCENT=8.5\nCOMPANY_TIMEZONE_OFFSET=-03:00\nSERVICE_PLOTAGEM_NBS_CODE=\nSERVICE_PLOTAGEM_IBS_CBS_TAX_STATUS=\nSERVICE_PLOTAGEM_IBS_CBS_TAX_CLASSIFICATION=\nSERVICE_PRODUCAO_NBS_CODE=\nSERVICE_PRODUCAO_IBS_CBS_TAX_STATUS=\nSERVICE_PRODUCAO_IBS_CBS_TAX_CLASSIFICATION=\n`;
if (!env.includes('# PAINEL UNIFICADO E MÓDULO FISCAL')) env += fiscalEnvBlock;
write(envPath, env);

const gitignorePath = path.join(projectRoot, '.gitignore');
let gitignore = read(gitignorePath);
for (const entry of ['data/fiscal/', 'storage/fiscal-documents/']) {
  if (!gitignore.includes(entry)) gitignore += `\n${entry}`;
}
write(gitignorePath, `${gitignore.trim()}\n`);

const migrationScript = `param(\n  [string]$SourcePath = (Join-Path (Split-Path $PSScriptRoot -Parent) '..\\PersonalizeNF')\n)\n\n$ErrorActionPreference = 'Stop'\n$Root = Split-Path $PSScriptRoot -Parent\n$SourcePath = (Resolve-Path $SourcePath).Path\n\nWrite-Host "Migrando dados fiscais de $SourcePath" -ForegroundColor Cyan\nNew-Item -ItemType Directory -Force -Path (Join-Path $Root 'data\\fiscal') | Out-Null\nNew-Item -ItemType Directory -Force -Path (Join-Path $Root 'storage\\fiscal-documents') | Out-Null\n\n$SourceDb = Join-Path $SourcePath 'data\\personalize-nf.sqlite'\nif (Test-Path $SourceDb) { Copy-Item $SourceDb (Join-Path $Root 'data\\fiscal\\personalize-nf.sqlite') -Force }\nforeach ($suffix in @('-wal','-shm')) {\n  if (Test-Path ($SourceDb + $suffix)) { Copy-Item ($SourceDb + $suffix) ((Join-Path $Root 'data\\fiscal\\personalize-nf.sqlite') + $suffix) -Force }\n}\n$SourceDocs = Join-Path $SourcePath 'storage\\documents'\nif (Test-Path $SourceDocs) { Copy-Item (Join-Path $SourceDocs '*') (Join-Path $Root 'storage\\fiscal-documents') -Recurse -Force }\n\n$SourceEnv = Join-Path $SourcePath '.env'\n$TargetEnv = Join-Path $Root '.env'\nif (Test-Path $SourceEnv) {\n  $allowed = '^(DEMO_MODE|DEMO_APPROVAL_DELAY_MS|ALLOW_PRODUCTION|FOCUS_|DPS_SERIES|COMPANY_|SERVICE_|ADMIN_NAME|ADMIN_EMAIL|ADMIN_PASSWORD|SESSION_SECRET)'\n  $target = if (Test-Path $TargetEnv) { [System.Collections.Generic.List[string]](Get-Content $TargetEnv) } else { [System.Collections.Generic.List[string]]::new() }\n  foreach ($line in Get-Content $SourceEnv) {\n    if ($line -notmatch '^([A-Z0-9_]+)=(.*)$') { continue }\n    $key = $Matches[1]\n    if ($key -notmatch $allowed) { continue }\n    $index = -1\n    for ($i = 0; $i -lt $target.Count; $i++) { if ($target[$i] -match "^$([regex]::Escape($key))=") { $index = $i; break } }\n    if ($index -ge 0) { $target[$index] = $line } else { $target.Add($line) }\n  }\n  Set-Content -Path $TargetEnv -Value $target -Encoding UTF8\n}\n\nWrite-Host 'Migração concluída. O PersonalizeNF separado pode permanecer como backup até a validação final.' -ForegroundColor Green\n`;
write(path.join(projectRoot, 'scripts', 'migrate-fiscal-local.ps1'), migrationScript);

const integrationTest = `'use strict';\n\nconst assert = require('node:assert/strict');\nconst fs = require('node:fs');\nconst path = require('node:path');\nconst root = path.resolve(__dirname, '..');\n\nfor (const file of [\n  'src/modules/fiscal/index.js',\n  'src/modules/fiscal/server.js',\n  'src/modules/fiscal/config.js',\n  'src/modules/fiscal/db.js',\n  'src/modules/fiscal/focusClient.js',\n  'src/modules/fiscal/payloadBuilder.js',\n  'public/fiscal/index.html',\n  'public/fiscal/app.js',\n  'src/services/fiscalModuleProcess.js',\n]) assert.equal(fs.existsSync(path.join(root, file)), true, \`arquivo fiscal ausente: \${file}\`);\n\nconst config = fs.readFileSync(path.join(root, 'src/modules/fiscal/config.js'), 'utf8');\nassert.match(config, /FISCAL_INTERNAL_PORT/);\nassert.match(config, /FISCAL_DATA_DIRECTORY/);\nassert.match(config, /PANEL_INTERNAL_SECRET/);\n\nconst server = fs.readFileSync(path.join(root, 'src/modules/fiscal/server.js'), 'utf8');\nassert.match(server, /x-personalize-panel-secret/);\n\nconst panel = fs.readFileSync(path.join(root, 'src/services/unifiedPanelServer.js'), 'utf8');\nassert.match(panel, /proxyFiscalRequest/);\nassert.match(panel, /url\.pathname === '\\/fiscal'/);\n\nconst app = fs.readFileSync(path.join(root, 'public/panel/app.js'), 'utf8');\nassert.match(app, /fiscal-frame/);\nassert.match(app, /\\/fiscal\\/\?embedded=1/);\n\nconsole.log('✅ Módulo fiscal completo integrado ao painel unificado.');\n`;
write(path.join(projectRoot, 'scripts', 'test-fiscal-integration.js'), integrationTest);

const packagePath = path.join(projectRoot, 'package.json');
const pkg = JSON.parse(read(packagePath));
pkg.scripts['test:fiscal-integration'] = 'node scripts/test-fiscal-integration.js';
if (!pkg.scripts.test.includes('test:fiscal-integration')) pkg.scripts.test += ' && npm run test:fiscal-integration';
write(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);

const docsPath = path.join(projectRoot, 'docs', 'PAINEL-UNIFICADO.md');
let docs = read(docsPath);
docs += `\n\n## Módulo fiscal integrado\n\nO núcleo completo do antigo PersonalizeNF agora está versionado em \`src/modules/fiscal\` e é iniciado automaticamente como processo local isolado. O painel principal faz proxy autenticado em \`/fiscal/\`, portanto não existe segundo login nem exposição direta da porta interna.\n\n- banco fiscal: \`data/fiscal/personalize-nf.sqlite\`;\n- documentos: \`storage/fiscal-documents\`;\n- processo interno: \`127.0.0.1:3031\`;\n- entrada única: painel em \`127.0.0.1:3030\`;\n- falha fiscal não encerra o bot.\n\nPara trazer banco, documentos e configurações locais do projeto antigo no Windows:\n\n\`\`\`powershell\n.\\scripts\\migrate-fiscal-local.ps1\n\`\`\`\n`;
write(docsPath, docs);

console.log('Módulo fiscal completo copiado e integrado ao PersonalizeProd.');
