'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const targets = [
  path.join(root, 'src'),
  path.join(root, 'scripts'),
];

function collectJavaScriptFiles(entryPath) {
  if (!fs.existsSync(entryPath)) return [];
  const stat = fs.statSync(entryPath);
  if (stat.isFile()) return /\.(?:js|cjs)$/i.test(entryPath) ? [entryPath] : [];

  const output = [];
  for (const entry of fs.readdirSync(entryPath, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    output.push(...collectJavaScriptFiles(path.join(entryPath, entry.name)));
  }
  return output;
}

const files = [
  ...targets.flatMap(collectJavaScriptFiles),
  path.join(root, 'ecosystem.config.cjs'),
].filter((filePath, index, list) => fs.existsSync(filePath) && list.indexOf(filePath) === index)
  .sort((a, b) => a.localeCompare(b));

const failures = [];
for (const filePath of files) {
  const result = spawnSync(process.execPath, ['--check', filePath], {
    cwd: root,
    encoding: 'utf8',
  });

  if (result.status !== 0) {
    failures.push({
      file: path.relative(root, filePath),
      output: String(result.stderr || result.stdout || '').trim(),
    });
  }
}

if (failures.length) {
  console.error(`❌ ${failures.length} arquivo(s) com erro de sintaxe:`);
  for (const failure of failures) {
    console.error(`\n--- ${failure.file} ---\n${failure.output}`);
  }
  process.exitCode = 1;
} else {
  console.log(`✅ Sintaxe verificada em ${files.length} arquivo(s).`);
}
