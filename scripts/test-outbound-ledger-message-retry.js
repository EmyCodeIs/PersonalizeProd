'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const originalCwd = process.cwd();
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'personalize-outbound-message-retry-'));
process.chdir(tempDir);
process.env.STORAGE_DRIVER = 'file';
process.env.OUTBOUND_LEDGER_ENABLED = 'true';
process.env.OUTBOUND_TEXT_ATTEMPTS = '2';
process.env.OUTBOUND_TEXT_RETRY_MS = '0';
process.env.ENABLE_TYPING = 'false';

(async () => {
  try {
    const Context = require('../src/core/outboundLedgerContext');
    const Ledger = require('../src/services/outboundLedgerStore');
    const { wrapChannel } = require('../src/core/outboundLedgerPreload');
    const { installMessageExperience } = require('../src/core/messageExperience');

    let rawSends = 0;
    const channel = {
      client: {},
      async sendText() {
        rawSends += 1;
        if (rawSends === 1) throw Object.assign(new Error('primeira tentativa falhou'), { code: 'TEMP' });
        return { id: { _serialized: 'message-retry-confirmed' } };
      },
    };
    wrapChannel(channel);
    installMessageExperience(channel);

    const execute = () => Context.runForInboundBatch({
      conversationId: '5531999999781@c.us',
      inboxIds: ['msg:retry-inbound'],
      source: 'test',
    }, () => channel.sendText('5531999999781@c.us', 'Resposta com retry', { noTyping: true }));

    const result = await execute();
    assert.equal(result.id._serialized, 'message-retry-confirmed');
    assert.equal(rawSends, 2);

    let records = Ledger.listAll();
    assert.equal(records.length, 1, 'as duas tentativas precisam usar um único registro');
    assert.equal(records[0].status, Ledger.STATUS.SENT);
    assert.equal(records[0].attempts, 2);
    assert.equal(records[0].messageId, 'message-retry-confirmed');

    await execute();
    records = Ledger.listAll();
    assert.equal(rawSends, 2, 'replay da mesma entrada não pode reenviar a resposta confirmada');
    assert.equal(records.length, 1);
    assert.equal(
      records[0].deduplicatedCalls,
      2,
      'o contador inclui a tentativa repetida após falha e o replay bloqueado após confirmação',
    );

    console.log('✅ Retry de texto: uma operação, duas tentativas e nenhum reenvio após confirmação.');
  } finally {
    process.chdir(originalCwd);
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
