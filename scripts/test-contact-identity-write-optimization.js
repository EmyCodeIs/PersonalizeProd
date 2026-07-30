'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'personalize-identities-'));
process.chdir(tempRoot);
process.env.STORAGE_DRIVER = 'file';
process.env.IDENTITY_TOUCH_INTERVAL_MS = '60000';

const Persistence = require('../src/services/persistence');
const originalWriteJson = Persistence.writeJson;
let writes = 0;
Persistence.writeJson = function countedWrite(...args) {
  writes += 1;
  return originalWriteJson(...args);
};

const Identity = require('../src/services/contactIdentity');

try {
  const first = Identity.registerContact({
    chatId: '5511999999999@c.us',
    phone: '11999999999',
  });
  assert.ok(first);
  assert.equal(writes, 1, 'primeiro cadastro precisa ser persistido');

  const repeated = Identity.registerContact({
    chatId: '5511999999999@c.us',
    phone: '11999999999',
  });
  assert.equal(repeated.contactKey, first.contactKey);
  assert.equal(writes, 1, 'cadastro idêntico dentro do intervalo não deve regravar o documento inteiro');

  const withLid = Identity.registerContact({
    chatId: '123456789012345@lid',
    raw: { sender: { number: '5511999999999' } },
  });
  assert.ok(withLid.aliases.includes('123456789012345@lid'));
  assert.ok(writes >= 2, 'novo alias precisa ser persistido imediatamente');
  assert.ok(Identity.getLabelCandidateIds('123456789012345@lid').includes('5511999999999@c.us'));

  console.log('✅ Identidades: repetição não regrava e novos aliases continuam persistidos.');
} finally {
  Persistence.writeJson = originalWriteJson;
  fs.rmSync(tempRoot, { recursive: true, force: true });
}