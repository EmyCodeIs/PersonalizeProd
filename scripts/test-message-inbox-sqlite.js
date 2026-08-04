'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const originalCwd = process.cwd();
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'personalize-inbox-sqlite-'));
process.chdir(tempDir);
process.env.STORAGE_DRIVER = 'sqlite';
process.env.SQLITE_DATABASE_PATH = 'data/inbox-test.sqlite';
process.env.DATA_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

try {
  const Inbox = require('../src/services/messageInboxStore');
  const Persistence = require('../src/services/persistence');
  const clientId = '5531999999821@c.us';
  const secretText = 'Mensagem privada do cliente para orçamento 8472';

  const record = Inbox.receive({
    from: clientId,
    text: secretText,
    source: 'event',
    raw: {
      id: { _serialized: 'sqlite-inbox-message-1' },
      from: clientId,
      type: 'chat',
      body: secretText,
    },
  }).record;

  const row = Persistence.getDatabase().prepare(`
    SELECT message_key, conversation_key, status, encrypted_payload
    FROM secure_inbox_messages
    WHERE message_key = ?
  `).get(record.id);

  assert.equal(row.message_key, record.id);
  assert.equal(row.conversation_key, clientId);
  assert.equal(row.status, Inbox.STATUS.RECEIVED);
  assert.ok(String(row.encrypted_payload).startsWith('v1.'));
  assert.equal(String(row.encrypted_payload).includes(secretText), false, 'texto do cliente não pode ficar em claro no SQLite');

  Inbox.markBuffered([record.id], { conversationId: clientId });
  Inbox.markQueued([record.id]);
  Inbox.claimBatch([record.id], { owner: 'sqlite-test', leaseMs: 60000 });
  Inbox.markProcessed([record.id]);
  assert.equal(Inbox.readRecord(record.id).text, secretText);
  assert.equal(Inbox.readRecord(record.id).status, Inbox.STATUS.PROCESSED);

  Persistence.close();
  for (const modulePath of [
    '../src/services/messageInboxStore',
    '../src/services/persistence',
  ]) delete require.cache[require.resolve(modulePath)];

  const ReloadedInbox = require('../src/services/messageInboxStore');
  assert.equal(ReloadedInbox.readRecord(record.id).status, ReloadedInbox.STATUS.PROCESSED);
  assert.equal(ReloadedInbox.readRecord(record.id).text, secretText);

  require('../src/services/persistence').close();
  console.log('✅ Inbox SQLite: registro por mensagem, payload criptografado e leitura após reinício verificados.');
} finally {
  process.chdir(originalCwd);
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
}
