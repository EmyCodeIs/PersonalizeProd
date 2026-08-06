'use strict';

const assert = require('assert/strict');
const path = require('path');

process.env.MOCK_MODE = 'true';

const {
  parseExtraArgs,
  resolveBrowserArgs,
  resolveBrowserExecutable,
} = require('../src/core/vpsBrowserPreload');

assert.deepEqual(
  parseExtraArgs('--disable-gpu; --window-size=1366,768\n--lang=pt-BR'),
  ['--disable-gpu', '--window-size=1366,768', '--lang=pt-BR'],
);

const fs = require('fs');
const os = require('os');
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'personalize-browser-test-'));
const fakeChrome = path.join(cwd, 'chrome.exe');
fs.writeFileSync(fakeChrome, 'fake');
assert.equal(resolveBrowserExecutable({ platform: 'win32', configured: fakeChrome }), fakeChrome);
const common = [
  `--disk-cache-dir=${path.resolve(cwd, 'data/browser-cache')}`,
  '--disk-cache-size=104857600',
  '--media-cache-size=52428800',
];

assert.deepEqual(
  resolveBrowserArgs({ platform: 'win32', isRoot: false, configured: '', cwd }),
  common,
);

assert.deepEqual(
  resolveBrowserArgs({ platform: 'linux', isRoot: false, configured: '', cwd }),
  [...common, '--disable-dev-shm-usage'],
);

assert.deepEqual(
  resolveBrowserArgs({ platform: 'linux', isRoot: true, configured: '', cwd }),
  [...common, '--disable-dev-shm-usage', '--no-sandbox', '--disable-setuid-sandbox'],
);

const custom = resolveBrowserArgs({
  platform: 'linux',
  isRoot: true,
  cwd,
  configured: '--disk-cache-size=20971520;--lang=pt-BR',
});
assert.equal(custom.includes('--disk-cache-size=20971520'), true);
assert.equal(custom.includes('--disk-cache-size=104857600'), false);
assert.equal(custom.includes('--lang=pt-BR'), true);
assert.equal(custom.includes('--disable-dev-shm-usage'), true);
assert.equal(custom.includes('--no-sandbox'), true);

fs.rmSync(cwd, { recursive: true, force: true });
console.log('✅ Chrome verificado: executável do sistema, cache fora de tokens e execução Linux/root.');
