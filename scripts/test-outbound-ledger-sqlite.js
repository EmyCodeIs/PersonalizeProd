'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const originalCwd = process.cwd();
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'personalize-outbound-sqlite-'));
process.chdir(tempDir);
process.env.STORAGE_DRIVER = 'sqlite';
process.env.SQLITE_DATABASE_PATH = 'data/test.sqlite';
process.env.DATA_ENCRYPTION_KEY = '11'.repeat(32);
process.env.OUTBOUND_LEDGER_ENABLED = 'true';

function clearModules() {
  for (const modulePath of [
    '../src/services/outboundLedgerStore',
    '../src/services/contactIdentity',
    '../src/services/persistence',
    '../src/config/leadOperationsConfig',
    '../src/config/env',
  ]) {
    try { delete require.cache[require.resolve(modulePath)]; } catch (_) {}
  }
}

(async () => {
  try {
    clearModules();
    let Persistence = require('../src/services/persistence');
    let Ledger = require('../src/services/outboundLedgerStore');
    const text = 'Mensagem confidencial do bot para o cliente';

    await Ledger.dispatch({
      operationKey: 'sqlite-ledger-operation',
      conversationId: '5531999999702@c.us',
      type: 'text',
      text,
    }, async () => ({ id: { _serialized: 'sqlite-out-1' } }));

    const db = Persistence.getDatabase();
    const row = db.prepare('SELECT * FROM secure_outbound_messages WHERE operation_key = ?')
      .get('sqlite-ledger-operation');
    assert.ok(row);
    assert.equal(row.status, Ledger.STATUS.SENT);
    assert.ok(String(row.encrypted_payload).startsWith('v1.'));
    assert.equal(JSON.stringify(row).includes(text), false, 'texto do cliente não pode ficar em coluna aberta');

    Persistence.close();
    clearModules();
    Persistence = require('../src/services/persistence');
    Ledger = require('../src/services/outboundLedgerStore');
    const restored = Ledger.readByOperationKey('sqlite-ledger-operation');
    assert.equal(restored.text, text);
    assert.equal(restored.messageId, 'sqlite-out-1');
    assert.equal(restored.status, Ledger.STATUS.SENT);
    Persistence.close();

    console.log('✅ Ledger SQLite: payload criptografado e persistência após reinício verificados.');
  } finally {
    process.chdir(originalCwd);
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
