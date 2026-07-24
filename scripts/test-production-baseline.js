'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const manifestPath = path.join(ROOT, 'docs', 'production-baseline.json');

function hashBuffer(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function normalizeTextLineEndings(value) {
  return String(value).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
}

function sha256Binary(filePath) {
  return hashBuffer(fs.readFileSync(filePath));
}

function sha256Text(filePath) {
  return hashBuffer(Buffer.from(normalizeTextLineEndings(fs.readFileSync(filePath, 'utf8')), 'utf8'));
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function relativeRequireOrder(source) {
  return [...source.matchAll(/require\(['"](\.\/core\/[^'"]+Preload)['"]\)/g)]
    .map((match) => match[1]);
}

function assertTrackedFile(item, group) {
  const absolute = path.join(ROOT, item.path);
  assert.ok(fs.existsSync(absolute), `${group}: arquivo ausente: ${item.path}`);

  // Arquivos de runtime são texto e podem chegar como LF (Linux/GitHub) ou
  // CRLF (Windows com core.autocrlf). Normalizamos somente as quebras de linha
  // antes do hash. Assets continuam binários e precisam ser idênticos byte a byte.
  const currentHash = group === 'runtime' ? sha256Text(absolute) : sha256Binary(absolute);
  assert.strictEqual(
    currentHash,
    item.sha256,
    `${group}: conteúdo da produção mudou sem atualizar o baseline: ${item.path}`,
  );

  if (Number.isFinite(Number(item.size))) {
    assert.strictEqual(fs.statSync(absolute).size, Number(item.size), `${group}: tamanho alterado: ${item.path}`);
  }
}

// Protege explicitamente a compatibilidade multiplataforma do próprio teste.
assert.strictEqual(
  hashBuffer(Buffer.from(normalizeTextLineEndings('linha 1\nlinha 2\n'), 'utf8')),
  hashBuffer(Buffer.from(normalizeTextLineEndings('linha 1\r\nlinha 2\r\n'), 'utf8')),
  'normalização LF/CRLF do baseline deixou de ser equivalente',
);

const manifest = readJson(manifestPath);
const packageJson = readJson(path.join(ROOT, 'package.json'));

assert.strictEqual(manifest.repository, 'EmyCodeIs/PersonalizeProd');
assert.strictEqual(manifest.productionBranch, 'main');
assert.strictEqual(manifest.productionCommit, 'fe6ca12df261015fdca9a2df87caa608ac51c944');
assert.strictEqual(packageJson.name, manifest.package.name, 'nome do pacote da produção foi alterado');
assert.strictEqual(packageJson.version, manifest.package.version, 'versão da produção foi alterada');
assert.strictEqual(packageJson.main, manifest.package.main, 'entrypoint principal foi alterado');
assert.strictEqual(packageJson.scripts?.start, manifest.package.start, 'comando de início foi alterado');

for (const item of manifest.protectedRuntimeFiles || []) assertTrackedFile(item, 'runtime');
for (const item of manifest.protectedAssets || []) assertTrackedFile(item, 'asset');

const currentAssets = [];
const assetRoot = path.join(ROOT, 'assets');
for (const entry of fs.readdirSync(assetRoot, { withFileTypes: true })) {
  if (entry.isFile()) currentAssets.push(`assets/${entry.name}`);
}
currentAssets.sort();
const expectedAssets = (manifest.protectedAssets || []).map((item) => item.path).sort();
assert.deepStrictEqual(currentAssets, expectedAssets, 'lista de assets da produção mudou sem revisão do baseline');

const startSource = fs.readFileSync(path.join(ROOT, 'src', 'start-with-required-labels.js'), 'utf8');
assert.deepStrictEqual(
  relativeRequireOrder(startSource),
  manifest.startupPreloads,
  'ordem dos preloads da produção foi alterada',
);

for (const [name, value] of Object.entries(manifest.invariants || {})) {
  assert.strictEqual(value, false, `invariante inválida no baseline: ${name}`);
}

console.log(
  `✅ Baseline da produção protegido | versão=${packageJson.version} | commit=${manifest.productionCommit.slice(0, 8)} `
  + `| runtime=${manifest.protectedRuntimeFiles.length} | assets=${manifest.protectedAssets.length} `
  + `| preloads=${manifest.startupPreloads.length}`,
);