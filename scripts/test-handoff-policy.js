'use strict';

const assert = require('node:assert/strict');

function cacheStub(relative, exports) {
  const filename = require.resolve(relative);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
  return exports;
}

process.env.ADMIN_WHATSAPP_NUMBERS = '5531971386091';
process.env.ADMIN_WHATSAPP_CHAT_IDS = '18885055098907@lid';
process.env.ALLOWED_CLIENT_NUMBERS = '5531999999999';
process.env.LID_NUMBER_MAP = '18885055098907@lid=31971386091';

const env = {
  serviceLabelLetreiro: 'Orçamento letreiros',
  serviceLabelPlotagem: 'Plotagens',
  serviceLabelOutros: 'Outros',
  supportLabelName: 'Suporte',
  awaitingQuoteLabelName: 'Orçamento letreiros',
  serviceLabelReplaceGroup: ['Orçamento letreiros', 'Plotagens', 'Outros', 'Suporte'],
  sellerLabelRules: { adriano: '#111111', ana: '#222222', emy: '#333333', 'c. eduardo': '#444444' },
  lidNumberMap: { '18885055098907@lid': '31971386091' },
};
cacheStub('../src/config/env', { env });

const aliases = new Map([
  ['18885055098907@lid', ['18885055098907@lid', '5531971386091@c.us']],
  ['5531971386091@c.us', ['5531971386091@c.us', '18885055098907@lid']],
  ['5531999999999@c.us', ['5531999999999@c.us']],
]);
const Identity = cacheStub('../src/services/contactIdentity', {
  normalizeChatId(value) {
    const serialized = value && typeof value === 'object' ? (value._serialized || value.id?._serialized || value.id || '') : value;
    const raw = String(serialized || '').trim().toLowerCase();
    if (!raw) return '';
    if (/@(?:c\.us|g\.us|lid)$/.test(raw)) return raw;
    const digits = raw.replace(/\D/g, '');
    return digits ? `${digits}@c.us` : '';
  },
  getLabelCandidateIds(value) {
    const id = this.normalizeChatId(value);
    return aliases.get(id) || [id].filter(Boolean);
  },
  getSessionKey(value) {
    const ids = this.getLabelCandidateIds(value);
    return `wa:${ids.find((id) => id.endsWith('@lid')) || ids[0] || ''}`;
  },
});

const Policy = require('../src/core/handoffPolicy');
assert.equal(Policy.classifyLabelNames(['Orçamento letreiros']).assigned, false);
assert.equal(Policy.classifyLabelNames(['Plotagens', 'Suporte']).assigned, false);
assert.equal(Policy.classifyLabelNames([{ name: 'Ana' }]).reason, 'seller_label');
assert.equal(Policy.classifyLabelNames([{ name: 'Fornecedor' }]).reason, 'manual_label');
assert.equal(Policy.classifyLabelNames([{ color: 'red' }, {}]).assigned, false);
assert.equal(Policy.isStrictTesterIdentity({ from: '18885055098907@lid' }), true);
assert.equal(Policy.isStrictTesterIdentity({ from: '5531971386091@c.us' }), true);
assert.equal(Policy.isStrictTesterIdentity({ from: '5531999999999@c.us' }), false, 'whitelist geral não pode virar tester');

const blocks = new Map();
cacheStub('../src/services/humanControlStore', {
  getBlock(clientId) {
    const key = Identity.getSessionKey(clientId);
    return blocks.has(key) ? { blocked: true, control: blocks.get(key) } : { blocked: false, control: null };
  },
  setBlock(clientId, payload) {
    const key = Identity.getSessionKey(clientId);
    const control = { ...payload };
    blocks.set(key, control);
    return control;
  },
  clearBlock(clientId) { return blocks.delete(Identity.getSessionKey(clientId)); },
});

const labelState = new Map();
const SellerHandoff = cacheStub('../src/core/sellerHandoff', {
  _test: {
    async inspectChatLabels(_client, chatId) {
      return { available: true, chatFound: true, items: labelState.get(chatId) || [] };
    },
  },
  async getAutomationBlock() { return { blocked: false }; },
  registerManualTakeover() { return null; },
});

cacheStub('../src/core/sellerAliasHandoffPreload', {
  async resolveSellerLabelCandidates(_channel, clientId) {
    const direct = Identity.normalizeChatId(clientId);
    const candidates = Identity.getLabelCandidateIds(clientId);
    return { direct, candidates, conclusiveIdentity: true };
  },
});

const SellerEvents = cacheStub('../src/core/sellerLabelEvents', {
  extractLabelUpdateChatId(data = {}) { return String(data.chatId || data?.chat?.id?._serialized || ''); },
  labelNamesFromUpdate(data = {}) { return (data.labels || []).map((item) => String(item.name || item.label || '')).filter(Boolean); },
  persistSellerStatus() { return true; },
  createSellerLabelUpdateHandler() { throw new Error('deve ser substituído'); },
});

const runtime = { buffers: new Set(), queues: new Set() };
let resetMarks = 0;
const TesterRuntime = cacheStub('../src/core/testerRuntime', {
  _test: { runtime },
  clearTesterConversationRuntime() { return { discardedBuffers: 0, cancelledTasks: 0, reset: { reset: true } }; },
});
cacheStub('../src/services/handoffResetStore', {
  markReset(clientId) { resetMarks += 1; return { at: new Date().toISOString(), chatId: clientId }; },
  getResetCheckpoint() { return null; },
});
cacheStub('../src/core/runtimeReliabilityPreload', { clearHistoricalHumanGuardCache() {} });

const { OutboundTracker } = require('../src/core/outboundTracker');
const tracker = new OutboundTracker();
let listCalls = 0;
const channel = {
  client: {
    async sendListMessage() { listCalls += 1; return { id: 'list-id' }; },
    async sendList() { listCalls += 1; return { id: 'list2-id' }; },
  },
  outboundTracker: tracker,
  async sendText(chatId, text) { return { id: `${chatId}:${text}` }; },
  async sendImage() { return true; },
  async sendDocument() { return true; },
  async sendCatalog() { return true; },
};
const WppClient = cacheStub('../src/services/wppconnectClient', {
  async createWppChannel() { return channel; },
  async collectUnreadMessages() { return []; },
});

const buffer = { cleared: [], clear(id) { this.cleared.push(id); return 1; } };
const queue = { cancelled: [], cancelQueuedForChats(ids, code) { this.cancelled.push({ ids, code }); return 1; } };
runtime.buffers.add(buffer);
runtime.queues.add(queue);

const Safety = require('../src/core/handoffSafetyPreload');

(async () => {
  labelState.set('5531999999999@c.us', [{ name: 'Orçamento letreiros' }]);
  let guard = await SellerHandoff.getAutomationBlock(channel, '5531999999999@c.us');
  assert.equal(guard.blocked, false, 'etiqueta nativa não pode bloquear');

  Safety.invalidateLabelInspection('5531999999999@c.us');
  labelState.set('5531999999999@c.us', [{ name: 'Fornecedor' }]);
  guard = await SellerHandoff.getAutomationBlock(channel, '5531999999999@c.us');
  assert.equal(guard.blocked, true);
  assert.equal(guard.reason, 'manual_label');
  assert.ok(buffer.cleared.length > 0);
  assert.ok(queue.cancelled.length > 0);

  labelState.set('5531999999999@c.us', [{ name: 'Orçamento letreiros' }]);
  Safety.invalidateLabelInspection('5531999999999@c.us');
  guard = await SellerHandoff.getAutomationBlock(channel, '5531999999999@c.us');
  assert.equal(guard.blocked, false, 'remoção da etiqueta externa deve liberar após leitura conclusiva');

  const manual = SellerHandoff.registerManualTakeover('5531999999999@c.us', { source: 'onAnyMessage' });
  assert.equal(manual.blocked, true);
  assert.equal(manual.reason, 'manual_outbound_message');

  await assert.rejects(
    () => WppClient.createWppChannel().then((created) => created.sendText('5531999999999@c.us', 'teste')),
    (error) => error.code === 'HUMAN_HANDOFF_BLOCKED',
  );

  const created = await WppClient.createWppChannel();
  await created.sendText('18885055098907@lid', 'reset ok');
  await created.client.sendListMessage('18885055098907@lid', { title: 'Lista de teste' });
  assert.equal(listCalls, 1);
  const matchedList = tracker.consumeIfBot('5531971386091@c.us', {
    to: '5531971386091@c.us', type: 'list', body: 'Lista de teste',
  });
  assert.ok(matchedList, 'lista do bot precisa ser reconhecida entre aliases');

  const handler = SellerEvents.createSellerLabelUpdateHandler({ getChannel: () => created, delayMs: 0 });
  let event = await handler({
    data: { chatId: '5531999999999@c.us', type: 'add', labels: [{ name: 'Suporte' }] }, channel: created,
  });
  assert.equal(event.reason, 'MANAGED_SERVICE_LABEL');
  event = await handler({
    data: { chatId: '18885055098907@lid', type: 'add', labels: [{ name: 'Fornecedor' }] }, channel: created,
  });
  assert.equal(event.reason, 'TESTER_IDENTITY');

  TesterRuntime.clearTesterConversationRuntime('18885055098907@lid');
  assert.equal(resetMarks, 1, 'reset deve gravar marco de histórico');

  console.log('✅ Política de handoff verificada: etiquetas nativas ignoradas, externas bloqueiam, saída protegida, aliases/listas e reset da tester.');
})().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
