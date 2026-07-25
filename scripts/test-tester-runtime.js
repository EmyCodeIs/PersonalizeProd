'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const originalCwd = process.cwd();
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'personalize-tester-runtime-'));
process.chdir(tempDir);

process.env.MOCK_MODE = 'true';
process.env.STORAGE_DRIVER = 'file';
process.env.ADMIN_WHATSAPP_NUMBERS = '5531971386091';
process.env.ADMIN_WHATSAPP_CHAT_IDS = '18885055098907@lid';
process.env.LID_NUMBER_MAP = '18885055098907@lid=31971386091';
process.env.TEST_COMMAND_ALLOWED_CLIENT_NUMBERS = '';
process.env.TEST_COMMAND_ALLOWED_CHAT_IDS = '';
process.env.ENABLE_TEST_COMMANDS = 'false';

async function run() {
  const Access = require('../src/core/testCommandAccess');
  const Identity = require('../src/services/contactIdentity');
  const Store = require('../src/services/leadStore');
  const HumanControl = require('../src/services/humanControlStore');
  const BotActivity = require('../src/services/botActivityStore');
  const SellerHandoff = require('../src/core/sellerHandoff');
  const BufferModule = require('../src/core/bufferManager');
  const QueueModule = require('../src/core/chatTaskQueue');
  const Runtime = require('../src/core/testerRuntime');

  const admin = Access.isTestCommandAuthorized({ from: '18885055098907@lid' });
  assert.equal(admin.allowed, true);
  assert.equal(admin.configSource, 'admin_whatsapp');
  assert.equal(Access.isTesterIdentity({ from: '5531971386091@c.us' }), true);
  assert.equal(Identity.normalizeChatId({ _serialized: '18885055098907@lid' }), '18885055098907@lid');
  assert.equal(Identity.normalizeChatId({ foo: 'bar' }), '');

  const TesterPreload = require('../src/core/testerHandoffBypassPreload');
  let stateCalls = 0;
  const connectedState = await TesterPreload.waitForOperationalConnection({ client: { getState: async () => (++stateCalls >= 2 ? 'CONNECTED' : 'SYNCING') } });
  assert.equal(connectedState, 'CONNECTED');
  assert.ok(stateCalls >= 2, 'SYNCING não pode liberar a conexão');
  const tester = '18885055098907@lid';
  const other = '5531999999999@c.us';
  Store.getSession(tester).etapa = 'cidade';
  Store.saveSession(Store.getSession(tester));
  Store.rememberCustomerProfile(tester, { name: 'Emilly' });
  Store.getSession(other).etapa = 'envio';
  Store.saveSession(Store.getSession(other));
  Store.rememberCustomerProfile(other, { name: 'Outro' });
  HumanControl.setBlock(tester, { reason: 'manual_label', source: 'teste', persistent: true });
  BotActivity.markBotOutbound(tester, { type: 'text' });

  const takeover = SellerHandoff.registerManualTakeover(tester, { reason: 'manual_outbound_message' });
  assert.equal(takeover.bypassed, true);
  assert.equal((await SellerHandoff.getAutomationBlock({ client: {} }, tester)).blocked, false);

  const buffer = new BufferModule.BufferManager({ delayMs: 5000, onFlush: async () => {} });
  buffer.push(tester, { text: 'pendente' });
  const queue = new QueueModule.ChatTaskQueue({ maxUnits: 1, maxConcurrentChats: 1, maxQueueSize: 4 });
  const running = queue.enqueue(other, async () => new Promise((resolve) => setTimeout(resolve, 30)));
  const queued = queue.enqueue(tester, async () => true).catch((error) => error);

  const cleanup = Runtime.clearTesterConversationRuntime(tester);
  assert.equal(cleanup.discardedBuffers, 1);
  assert.equal(cleanup.cancelledTasks, 1);
  assert.equal(Store.getCustomerProfile(tester), null);
  assert.equal(Store.getCustomerProfile(other)?.knownName, 'Outro');
  assert.equal(Store.getSession(other)?.etapa, 'envio');
  assert.equal(HumanControl.getBlock(tester).blocked, false);
  assert.equal(BotActivity.getLastBotOutbound(tester), null);
  assert.equal((await queued).code, 'RESETARSYS');
  await running;

  console.log('✅ Tester verificada: admin legado, sem handoff manual e /resetarsys isolado por conversa.');
}

run().catch((error) => {
  console.error('❌ Teste da tester falhou:', error?.stack || error?.message || error);
  process.exitCode = 1;
}).finally(() => {
  process.chdir(originalCwd);
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
});
