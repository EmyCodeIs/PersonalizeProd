'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const originalCwd = process.cwd();
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'personalize-recovery-cursor-'));
process.chdir(tempDir);
process.env.STORAGE_DRIVER = 'file';
process.env.CONVERSATION_RECOVERY_MAX_AGE_HOURS = '48';

(async () => {
try {
  const Cursor = require('../src/services/conversationCursorStore');
  const Recovery = require('../src/services/conversationRecovery');
  const Inbox = require('../src/services/messageInboxStore');

  const clientId = '5531999999711@c.us';
  const base = Date.now() - 3600000;
  Cursor.ensureBaseline(clientId, { at: base, source: 'session_state' });

  const messages = [
    { id: { _serialized: 'before' }, from: clientId, timestamp: (base + 500) / 1000, body: 'antes do cursor' },
    { id: { _serialized: 'after-2' }, from: clientId, timestamp: (base + 3000) / 1000, body: 'segunda mensagem' },
    { id: { _serialized: 'after-1' }, from: clientId, timestamp: (base + 2000) / 1000, body: 'primeira mensagem' },
    { id: { _serialized: 'outgoing' }, from: clientId, timestamp: (base + 4000) / 1000, body: 'resposta', fromMe: true },
  ];

  const selected = Recovery.selectAfterCursor(clientId, messages);
  assert.deepEqual(selected.selected.map((item) => item.messageId), ['after-1', 'after-2'], 'todas as mensagens posteriores devem ser recuperadas em ordem');
  assert.ok(selected.skipped.some((item) => item.reason === 'BEFORE_CURSOR'));

  const staged = Recovery.stageSelected(clientId, selected.selected, { source: 'test-cursor' });
  assert.equal(staged.stagedIds.length, 2);
  const records = staged.stagedIds.map((id) => Inbox.readRecord(id));
  assert.ok(records.every((record) => record.status === Inbox.STATUS.FAILED_RETRYABLE));
  assert.ok(new Date(records[0].receivedAt) < new Date(records[1].receivedAt), 'ordem de origem deve ser preservada na Inbox');

  Cursor.markProcessed(clientId, records[0]);
  Cursor.markProcessed(clientId, records[1]);
  assert.equal(Cursor.getCursor(clientId).lastProcessedMessageId, 'after-2');
  assert.equal(Recovery.selectAfterCursor(clientId, messages).selected.length, 0, 'cursor processado deve impedir replay duplicado');

  const resetAt = new Date(base + 10000).toISOString();
  Cursor.markReset(clientId, { at: resetAt, generation: 1 });
  const afterReset = Recovery.selectAfterCursor(clientId, [
    { id: { _serialized: 'old-reset' }, from: clientId, timestamp: (base + 9000) / 1000, body: 'antiga' },
    { id: { _serialized: 'new-reset' }, from: clientId, timestamp: (base + 11000) / 1000, body: 'nova' },
  ], { graceMs: 0 });
  assert.deepEqual(afterReset.selected.map((item) => item.messageId), ['new-reset']);
  assert.equal(afterReset.skipped[0].reason, 'BEFORE_RESET');

  const blockedClient = '5531999999712@c.us';
  const mockClient = {
    async getAllMessagesInChat(chatId) {
      return [{ id: { _serialized: `history-${chatId}` }, from: chatId, timestamp: Date.now() / 1000, body: 'mensagem pendente' }];
    },
  };
  const active = await Recovery.stageActiveSessions({
    channel: { client: mockClient },
    sessions: [
      { chatId: clientId, etapa: 'cidade', completed: false, updatedAt: new Date(base).toISOString(), dados: {} },
      { chatId: blockedClient, etapa: 'arte_coleta', completed: false, updatedAt: new Date(base).toISOString(), dados: {} },
    ],
    canRecover: async (id) => ({ blocked: id === blockedClient }),
  });
  assert.equal(active.conversations, 2);
  assert.ok(active.skipped >= 1, 'handoff deve impedir recuperação da conversa bloqueada');

  console.log('✅ Recuperação por cursor: lote completo, ordem, deduplicação, reset e handoff verificados.');
} finally {
  process.chdir(originalCwd);
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
}
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
