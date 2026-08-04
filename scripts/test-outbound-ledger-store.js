'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const originalCwd = process.cwd();
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'personalize-outbound-ledger-'));
process.chdir(tempDir);
process.env.STORAGE_DRIVER = 'file';
process.env.OUTBOUND_LEDGER_ENABLED = 'true';
process.env.OUTBOUND_LEDGER_MAX_ATTEMPTS = '3';

function freshLedger() {
  for (const modulePath of [
    '../src/services/outboundLedgerStore',
    '../src/services/contactIdentity',
    '../src/services/persistence',
    '../src/config/leadOperationsConfig',
    '../src/config/env',
  ]) {
    try { delete require.cache[require.resolve(modulePath)]; } catch (_) {}
  }
  return require('../src/services/outboundLedgerStore');
}

(async () => {
  try {
    let Ledger = freshLedger();
    const clientId = '5531999999701@c.us';
    let sendCount = 0;

    const first = await Ledger.dispatch({
      operationKey: 'flow:message-a:1:text:hello',
      conversationId: clientId,
      type: 'text',
      text: 'Olá, cliente',
      inboxIds: ['msg:message-a'],
    }, async () => {
      sendCount += 1;
      return { id: { _serialized: 'out-message-1' }, type: 'chat' };
    });
    assert.equal(first.id._serialized, 'out-message-1');
    assert.equal(sendCount, 1);

    const duplicate = await Ledger.dispatch({
      operationKey: 'flow:message-a:1:text:hello',
      conversationId: clientId,
      type: 'text',
      text: 'Olá, cliente',
    }, async () => {
      sendCount += 1;
      return true;
    });
    assert.equal(sendCount, 1, 'operação já enviada não pode chamar o WhatsApp novamente');
    assert.equal(duplicate.__outboundLedgerReplay, true);

    Ledger = freshLedger();
    const persisted = Ledger.readByOperationKey('flow:message-a:1:text:hello');
    assert.equal(persisted.status, Ledger.STATUS.SENT);
    assert.equal(persisted.messageId, 'out-message-1');

    let retryCount = 0;
    await assert.rejects(() => Ledger.dispatch({
      operationKey: 'flow:message-b:1:text:retry',
      conversationId: clientId,
      type: 'text',
      text: 'Tentar novamente',
    }, async () => {
      retryCount += 1;
      throw Object.assign(new Error('falha temporária'), { code: 'TEMP' });
    }));
    assert.equal(Ledger.readByOperationKey('flow:message-b:1:text:retry').status, Ledger.STATUS.FAILED_RETRYABLE);

    await Ledger.dispatch({
      operationKey: 'flow:message-b:1:text:retry',
      conversationId: clientId,
      type: 'text',
      text: 'Tentar novamente',
    }, async () => {
      retryCount += 1;
      return { id: { _serialized: 'out-message-2' } };
    });
    assert.equal(retryCount, 2);
    assert.equal(Ledger.readByOperationKey('flow:message-b:1:text:retry').status, Ledger.STATUS.SENT);

    Ledger.begin({
      operationKey: 'flow:message-c:1:text:uncertain',
      conversationId: clientId,
      type: 'text',
      text: 'Pode ter sido enviada',
      now: 100000,
    });
    const uncertain = Ledger.begin({
      operationKey: 'flow:message-c:1:text:uncertain',
      conversationId: clientId,
      type: 'text',
      text: 'Pode ter sido enviada',
      now: 200000,
      uncertainAfterMs: 30000,
    });
    assert.equal(uncertain.shouldSend, false);
    assert.equal(uncertain.record.status, Ledger.STATUS.UNCERTAIN);

    const conversation = Ledger.listConversation(clientId);
    assert.equal(conversation.length, 3);
    assert.equal(Ledger.stats().SENT, 2);
    assert.equal(Ledger.stats().UNCERTAIN, 1);

    console.log('✅ Ledger de saída: persistência, deduplicação, retry e envio incerto verificados.');
  } finally {
    process.chdir(originalCwd);
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
