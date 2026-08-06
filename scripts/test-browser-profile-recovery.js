'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  cleanupStaleProfileMarkers,
  findProfileMarkers,
  profileIsActive,
} = require('../src/core/browserProfileRecovery');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'personalize-profile-recovery-'));
const profile = path.join(root, 'tokens', 'personalize-wppconnect');
const indexedDb = path.join(profile, 'Default', 'IndexedDB', 'auth.ldb');
fs.mkdirSync(path.dirname(indexedDb), { recursive: true });
fs.writeFileSync(indexedDb, 'sessao');
fs.writeFileSync(path.join(profile, 'DevToolsActivePort'), 'antigo');
fs.writeFileSync(path.join(profile, 'SingletonLock'), 'antigo');
fs.writeFileSync(path.join(profile, '.com.google.Chrome.test'), 'antigo');

try {
  assert.equal(findProfileMarkers(profile).length, 3);
  assert.equal(profileIsActive(profile, { processList: `123 chrome --user-data-dir=${profile}` }), true);

  const blocked = cleanupStaleProfileMarkers({ cwd: root, processList: `123 chrome --user-data-dir=${profile}` });
  assert.equal(blocked.skipped, true);
  assert.equal(findProfileMarkers(profile).length, 3);

  const cleaned = cleanupStaleProfileMarkers({ cwd: root, processList: '1 node app.js' });
  assert.equal(cleaned.removed, 3);
  assert.equal(findProfileMarkers(profile).length, 0);
  assert.equal(fs.readFileSync(indexedDb, 'utf8'), 'sessao');
  console.log('✅ Perfil Chrome: marcadores órfãos removidos sem tocar autenticação e perfil ativo preservado.');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
