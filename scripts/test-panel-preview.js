'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawn, spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const panelRoot = path.join(root, 'public', 'panel');
const productionIndex = fs.readFileSync(path.join(panelRoot, 'index.html'), 'utf8');
const previewHtml = fs.readFileSync(path.join(panelRoot, 'preview.html'), 'utf8');
const mode = fs.readFileSync(path.join(panelRoot, 'preview-mode.js'), 'utf8');
const shell = fs.readFileSync(path.join(panelRoot, 'preview-shell.js'), 'utf8');
const workspace = fs.readFileSync(path.join(panelRoot, 'preview-workspace.js'), 'utf8');
const connectionPage = fs.readFileSync(path.join(panelRoot, 'preview-connection-page.js'), 'utf8');
const observerGuard = fs.readFileSync(path.join(panelRoot, 'preview-observer-guard.js'), 'utf8');
const styles = fs.readFileSync(path.join(panelRoot, 'preview-workspace.css'), 'utf8');
const serverPath = path.join(root, 'scripts', 'start-panel-preview.js');
const serverSource = fs.readFileSync(serverPath, 'utf8');

for (const script of [
  path.join(panelRoot, 'preview-mode.js'),
  path.join(panelRoot, 'preview-shell.js'),
  path.join(panelRoot, 'preview-observer-guard.js'),
  path.join(panelRoot, 'preview-workspace.js'),
  path.join(panelRoot, 'preview-connection-page.js'),
  serverPath,
]) {
  const result = spawnSync(process.execPath, ['--check', script], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, `Erro de sintaxe em ${path.relative(root, script)}:\n${result.stderr || result.stdout}`);
}

assert.doesNotMatch(productionIndex, /preview-(?:mode|shell|workspace|connection|observer)/);
assert.match(productionIndex, /app\.js/);

for (const asset of [
  'preview-mode.js',
  'preview-shell.js',
  'preview-observer-guard.js',
  'preview-workspace.js',
  'preview-connection-page.js',
  'preview-workspace.css',
]) {
  assert.match(previewHtml, new RegExp(asset.replace('.', '\\.')));
}
assert.doesNotMatch(previewHtml, /src="\/app\.js"/);
assert.match(mode, /__PERSONALIZE_FRONTEND_PREVIEW__/);
assert.match(shell, /Emilly Santos/);
assert.match(shell, /Administrador/);
assert.match(observerGuard, /PreviewNoopMutationObserver/);
assert.match(observerGuard, /render -> mutation -> render/);
assert.match(workspace, /window\.addEventListener\('hashchange',schedule\)/);
assert.match(connectionPage, /connection-layout/);
assert.match(connectionPage, /QR demonstrativo/);

// O observer criado pelo workspace da prévia precisa ser inerte. Caso contrário,
// cada render altera o título e dispara um novo render, substituindo links durante o clique.
let restoreNativeObserver = null;
class FakeNativeMutationObserver {
  constructor(callback) { this.callback = callback; }
  observe() { this.observing = true; }
  disconnect() { this.observing = false; }
  takeRecords() { return ['native']; }
}
const fakeWindow = {
  __PERSONALIZE_FRONTEND_PREVIEW__: true,
  MutationObserver: FakeNativeMutationObserver,
  setTimeout(callback) { restoreNativeObserver = callback; },
};
vm.runInNewContext(observerGuard, { window: fakeWindow });
assert.notEqual(fakeWindow.MutationObserver, FakeNativeMutationObserver);
const previewObserver = new fakeWindow.MutationObserver(() => {});
previewObserver.observe({});
assert.deepEqual(previewObserver.takeRecords(), []);
assert.equal(typeof restoreNativeObserver, 'function');
restoreNativeObserver();
assert.equal(fakeWindow.MutationObserver, FakeNativeMutationObserver);

for (const route of ['#\/leads', '#\/conexao', '#\/notas', '#\/integracao-fiscal', '#\/configuracoes']) {
  assert.match(workspace, new RegExp(route));
}
for (const area of ['Visão geral', 'Leads', 'Notas fiscais', 'Integração fiscal', 'Configurações']) {
  assert.match(workspace, new RegExp(area));
}
for (const fiscalArea of ['Nova NFS-e', 'Rascunhos', 'Notas emitidas', 'Erros']) {
  assert.match(workspace, new RegExp(fiscalArea));
}
for (const settingsArea of ['Empresa', 'Usuários', 'Atendimento', 'Bot', 'Fiscal', 'Aparência', 'Sistema', 'Segurança']) {
  assert.match(workspace, new RegExp(settingsArea));
}
assert.match(styles, /\.pw-settings/);
assert.match(styles, /\.pw-drawer/);
assert.match(styles, /@media\(max-width:760px\)/);
assert.doesNotMatch(serverSource, /require\([^)]*(?:wppconnect|start-with-required-labels)|FocusClient/i);
assert.match(serverSource, /frontend-preview/);
assert.match(serverSource, /preview\.html/);

const port = 4197;
const child = spawn(process.execPath, [serverPath], {
  cwd: root,
  env: { ...process.env, PANEL_PREVIEW_PORT: String(port) },
  stdio: ['ignore', 'pipe', 'pipe'],
});

async function waitForHealth() {
  let lastError;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      const payload = await response.json();
      assert.equal(payload.ok, true);
      assert.equal(payload.mode, 'frontend-preview');
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw lastError || new Error('Servidor de prévia não respondeu.');
}

(async () => {
  try {
    await waitForHealth();

    const pageResponse = await fetch(`http://127.0.0.1:${port}/`);
    const page = await pageResponse.text();
    assert.match(page, /Prévia do Painel Personalize/);
    assert.match(page, /preview-workspace\.js/);
    assert.doesNotMatch(page, /src="\/app\.js"/);

    const response = await fetch(`http://127.0.0.1:${port}/api/auth/me`);
    const payload = await response.json();
    assert.equal(payload.user.role, 'admin');
    console.log('Prévia do painel: navegação, módulos, conexão visual e servidor isolado validados.');
  } finally {
    child.kill('SIGTERM');
  }
})().catch((error) => {
  child.kill('SIGTERM');
  console.error(error);
  process.exitCode = 1;
});
