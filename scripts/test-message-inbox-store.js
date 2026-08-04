'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const originalCwd = process.cwd();
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'personalize-inbox-store-'));
process.chdir(tempDir);
process.env.STORAGE_DRIVER = 'file';

function freshInbox() {
  for (const modulePath of [
    '../src/services/messageInboxStore',
    '../src/services/persistence',
  ]) {
    delete require.cache[require.resolve(modulePath)];
  }
  return require('../src/services/messageInboxStore');
}

try {
  let Inbox = freshInbox();
  const clientA = '5531999999801@c.us';
  const clientB = '5531999999802@c.us';

  const first = Inbox.receive({
    from: clientA,
    text: 'Olá',
    source: 'event',
    raw: { id: { _serialized: 'message-a-1' }, from: clientA, timestamp: 1785852000, type: 'chat', body: 'Olá' },
  });
  assert.equal(first.duplicate, false);
  assert.equal(first.record.status, Inbox.STATUS.RECEIVED);

  const duplicate = Inbox.receive({
    from: clientA,
    text: 'Olá',
    source: 'unread-bootstrap',
    raw: { id: { _serialized: 'message-a-1' }, from: clientA, timestamp: 1785852000, type: 'chat', body: 'Olá' },
  });
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.record.id, first.record.id);
  assert.equal(Inbox.stats().total, 1, 'a mesma mensagem precisa ocupar um único registro');

  Inbox.markBuffered([first.record.id], { conversationId: clientA });
  Inbox.markQueued([first.record.id], { conversationId: clientA });
  const claimed = Inbox.claimBatch([first.record.id], {
    owner: 'test-runtime',
    leaseMs: 60000,
    now: 100000,
  });
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0].status, Inbox.STATUS.PROCESSING);
  assert.equal(claimed[0].attempts, 1);

  Inbox.markFailure(
    [first.record.id],
    Object.assign(new Error('falha temporária'), { code: 'TEMPORARY' }),
    { maxAttempts: 3, baseDelayMs: 1000, now: 101000 },
  );
  assert.equal(Inbox.readRecord(first.record.id).status, Inbox.STATUS.FAILED_RETRYABLE);

  Inbox.requeueForReplay(first.record.id, { now: 103000 });
  Inbox.markQueued([first.record.id]);
  Inbox.claimBatch([first.record.id], { owner: 'test-runtime', leaseMs: 60000, now: 104000 });
  Inbox.markFailure([first.record.id], new Error('segunda falha'), {
    maxAttempts: 3,
    baseDelayMs: 1000,
    now: 105000,
  });
  assert.equal(Inbox.readRecord(first.record.id).attempts, 2);
  assert.equal(Inbox.readRecord(first.record.id).status, Inbox.STATUS.FAILED_RETRYABLE);

  Inbox.requeueForReplay(first.record.id, { now: 108000 });
  Inbox.markQueued([first.record.id]);
  Inbox.claimBatch([first.record.id], { owner: 'test-runtime', leaseMs: 60000, now: 109000 });
  Inbox.markFailure([first.record.id], new Error('terceira falha'), {
    maxAttempts: 3,
    baseDelayMs: 1000,
    now: 110000,
  });
  assert.equal(Inbox.readRecord(first.record.id).attempts, 3);
  assert.equal(Inbox.readRecord(first.record.id).status, Inbox.STATUS.FAILED_FINAL);
  assert.equal(Inbox.listRecoverable({ now: 999999999, staleMs: 1 }).length, 0, 'dead-letter não pode retornar sozinho');

  const processed = Inbox.receive({
    from: clientB,
    text: 'Mensagem concluída',
    raw: { id: { _serialized: 'message-b-1' }, from: clientB, type: 'chat', body: 'Mensagem concluída' },
  }).record;
  Inbox.markBuffered([processed.id], { conversationId: clientB });
  Inbox.markQueued([processed.id]);
  Inbox.claimBatch([processed.id], { owner: 'test-runtime', leaseMs: 60000 });
  Inbox.markProcessed([processed.id]);

  Inbox = freshInbox();
  assert.equal(
    Inbox.readRecord(processed.id).status,
    Inbox.STATUS.PROCESSED,
    'status processado precisa sobreviver ao reinício do processo',
  );
  assert.equal(
    Inbox.receive({
      from: clientB,
      text: 'Mensagem concluída',
      raw: { id: { _serialized: 'message-b-1' }, from: clientB, type: 'chat' },
    }).duplicate,
    true,
    'deduplicação precisa sobreviver ao reinício',
  );

  const pendingA = Inbox.receive({
    from: clientA,
    text: 'Pendente A',
    raw: { id: { _serialized: 'message-a-pending' }, from: clientA, type: 'chat' },
  }).record;
  const pendingB = Inbox.receive({
    from: clientB,
    text: 'Pendente B',
    raw: { id: { _serialized: 'message-b-pending' }, from: clientB, type: 'chat' },
  }).record;
  Inbox.markBuffered([pendingA.id], { conversationId: clientA });
  Inbox.markBuffered([pendingB.id], { conversationId: clientB });
  Inbox.markResetForConversation(clientA, [], { reason: 'tester_reset' });
  assert.equal(Inbox.readRecord(pendingA.id).status, Inbox.STATUS.RESET);
  assert.equal(Inbox.readRecord(pendingB.id).status, Inbox.STATUS.BUFFERED, 'reset não pode atingir outro cliente');

  const leased = Inbox.receive({
    from: '5531999999803@c.us',
    text: 'Lease vencido',
    raw: { id: { _serialized: 'message-expired-lease' }, from: '5531999999803@c.us', type: 'chat' },
  }).record;
  Inbox.markQueued([leased.id]);
  Inbox.claimBatch([leased.id], { owner: 'old-runtime', leaseMs: 1000, now: 200000 });
  const recoverable = Inbox.listRecoverable({ now: 202000, staleMs: 1, limit: 20 });
  assert.ok(recoverable.some((item) => item.id === leased.id), 'lease vencido precisa voltar para recuperação');

  console.log('✅ Inbox persistente: deduplicação, reinício, retry, dead-letter, reset isolado e lease vencido verificados.');
} finally {
  process.chdir(originalCwd);
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
}
