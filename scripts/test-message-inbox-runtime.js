'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const originalCwd = process.cwd();
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'personalize-inbox-runtime-'));
process.chdir(tempDir);
process.env.STORAGE_DRIVER = 'file';
process.env.MESSAGE_INBOX_ENABLED = 'true';
process.env.MESSAGE_INBOX_RETRY_BASE_MS = '1000';
process.env.MESSAGE_INBOX_MAX_ATTEMPTS = '3';
process.env.MESSAGE_INBOX_RECOVERY_DELAY_MS = '60000';
process.env.MESSAGE_INBOX_RETRY_POLL_MS = '60000';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function run() {
  const modulePaths = [
    '../src/core/messageInboxPreload',
    '../src/services/messageInboxStore',
    '../src/services/persistence',
    '../src/services/wppconnectClient',
    '../src/services/humanControlStore',
    '../src/flow/customerFlow',
    '../src/core/bufferManager',
    '../src/config/inboxConfig',
    '../src/config/env',
  ];
  for (const modulePath of modulePaths) delete require.cache[require.resolve(modulePath)];

  const WppClient = require('../src/services/wppconnectClient');
  const CustomerFlow = require('../src/flow/customerFlow');
  const HumanControl = require('../src/services/humanControlStore');
  const { BufferManager, mergeMessages } = require('../src/core/bufferManager');
  const Inbox = require('../src/services/messageInboxStore');

  let processCount = 0;
  let failNext = false;
  CustomerFlow.processCustomerMessage = async ({ clientId, text }) => {
    processCount += 1;
    if (failNext) {
      failNext = false;
      const error = new Error(`falha simulada em ${clientId}: ${text}`);
      error.code = 'SIMULATED_FLOW_FAILURE';
      throw error;
    }
    return { clientId, text, ok: true };
  };

  WppClient.createWppChannel = async (options = {}) => {
    const channel = {
      client: {},
      sendText: async () => true,
      markUnread: async () => true,
      emitMessage: (payload) => options.onMessage?.(payload),
    };
    return channel;
  };
  delete WppClient.__persistentInboxInstalled;

  require('../src/core/messageInboxPreload');

  let channel;
  const buffer = new BufferManager({
    delayMs: 100,
    onFlush: async (clientId, messages) => CustomerFlow.processCustomerMessage({
      clientId,
      text: mergeMessages(messages),
      channel,
      messages,
    }),
  });

  channel = await WppClient.createWppChannel({
    onMessage: async (payload) => {
      buffer.push(payload.from, {
        text: payload.text,
        raw: payload.raw,
        source: payload.source,
      }, { delayMs: 100 });
    },
  });

  const client = '5531999999811@c.us';
  const raw = {
    id: { _serialized: 'runtime-message-1' },
    from: client,
    timestamp: Math.floor(Date.now() / 1000),
    type: 'chat',
    body: 'Primeira mensagem',
  };

  await channel.emitMessage({ from: client, text: 'Primeira mensagem', raw, source: 'event' });
  await sleep(250);
  assert.equal(processCount, 1);
  assert.equal(Inbox.readRecord('msg:runtime-message-1').status, Inbox.STATUS.PROCESSED);

  await channel.emitMessage({ from: client, text: 'Primeira mensagem', raw, source: 'unread-bootstrap' });
  await sleep(180);
  assert.equal(processCount, 1, 'duplicata não pode chegar novamente ao fluxo');
  assert.equal(Inbox.stats().PROCESSED, 1);

  failNext = true;
  await channel.emitMessage({
    from: client,
    text: 'Falhar uma vez',
    source: 'event',
    raw: {
      id: { _serialized: 'runtime-message-2' },
      from: client,
      timestamp: Math.floor(Date.now() / 1000),
      type: 'chat',
      body: 'Falhar uma vez',
    },
  });
  await sleep(250);

  const failed = Inbox.readRecord('msg:runtime-message-2');
  assert.equal(failed.status, Inbox.STATUS.FAILED_RETRYABLE);
  assert.equal(failed.attempts, 1);

  Inbox.transition([failed.id], Inbox.STATUS.FAILED_RETRYABLE, {
    reason: 'liberar_retry_do_teste',
    patch: { availableAt: new Date(0).toISOString() },
  });
  await channel.__runPersistentInboxRecovery('test-retry');
  await sleep(250);

  const retried = Inbox.readRecord(failed.id);
  assert.equal(retried.status, Inbox.STATUS.PROCESSED);
  assert.equal(retried.attempts, 2);
  assert.equal(processCount, 3, 'fluxo precisa executar uma vez, falhar uma vez e concluir no retry');

  const blockedClient = '5531999999812@c.us';
  const blockedRecord = Inbox.receive({
    from: blockedClient,
    text: 'Não responder durante handoff',
    source: 'event',
    raw: { id: { _serialized: 'runtime-blocked-1' }, from: blockedClient, type: 'chat' },
  }).record;
  Inbox.markBuffered([blockedRecord.id], { conversationId: blockedClient });
  Inbox.writeRecord({
    ...Inbox.readRecord(blockedRecord.id),
    updatedAt: new Date(0).toISOString(),
  });
  HumanControl.setBlock(blockedClient, {
    reason: 'manual_outbound_message',
    source: 'test',
    persistent: true,
  });

  await channel.__runPersistentInboxRecovery('handoff-test');
  assert.equal(
    Inbox.readRecord(blockedRecord.id).status,
    Inbox.STATUS.IGNORED_HANDOFF,
    'recuperação não pode furar handoff persistente',
  );
  assert.equal(processCount, 3);

  const crashClient = '5531999999813@c.us';
  const crashed = Inbox.receive({
    from: crashClient,
    text: 'Recuperar depois de lease vencido',
    source: 'event',
    raw: { id: { _serialized: 'runtime-crash-1' }, from: crashClient, type: 'chat' },
  }).record;
  Inbox.markQueued([crashed.id], { conversationId: crashClient });
  Inbox.claimBatch([crashed.id], {
    owner: 'runtime-antigo',
    leaseMs: 1000,
    now: Date.now() - 5000,
  });

  await channel.__runPersistentInboxRecovery('expired-lease-test');
  await sleep(250);
  assert.equal(Inbox.readRecord(crashed.id).status, Inbox.STATUS.PROCESSED);
  assert.equal(processCount, 4, 'lease vencido precisa retomar exatamente uma vez');

  buffer.destroy();
  console.log('✅ Runtime da Inbox: processamento, deduplicação, retry, handoff e retomada de lease verificados.');
}

run()
  .catch((error) => {
    console.error('❌ Teste runtime da Inbox falhou:', error?.stack || error?.message || error);
    process.exitCode = 1;
  })
  .finally(() => {
    process.chdir(originalCwd);
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
  });
