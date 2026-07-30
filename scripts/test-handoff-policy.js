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
  sellerLabelRules: { Adriano: '#111111', Ana: '#222222', Emy: '#333333', 'C. Eduardo': '#444444' },
  lidNumberMap: { '18885055098907@lid': '31971386091' },
};
cacheStub('../src/config/env', { env });

const aliases = new Map([
  ['18885055098907@lid', ['18885055098907@lid', '5531971386091@c.us']],
  ['5531971386091@c.us', ['5531971386091@c.us', '18885055098907@lid']],
]);
const Identity = cacheStub('../src/services/contactIdentity', {
  normalizeChatId(value) {
    const serialized = value && typeof value === 'object'
      ? (value._serialized || value.id?._serialized || value.id || '')
      : value;
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
assert.equal(Policy.classifyLabelNames(['Suporte', 'Fornecedor']).reason, 'manual_label');
assert.equal(Policy.isStrictTesterIdentity({ from: '18885055098907@lid' }), false);
assert.equal(Policy.isStrictTesterIdentity({ from: '5531971386091@c.us' }), false);

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
const checkpoints = new Map();
const resetCheckpoints = new Map();
let resetMarks = 0;
const TesterRuntime = cacheStub('../src/core/testerRuntime', {
  _test: { runtime },
  clearTesterConversationRuntime(clientId) {
    const key = Identity.getSessionKey(clientId);
    const hadBlock = blocks.delete(key);
    checkpoints.delete(key);
    return {
      discardedBuffers: 0,
      cancelledTasks: 0,
      blocksCleared: hadBlock ? 1 : 0,
      activityCleared: 1,
      reset: { reset: true },
    };
  },
});
cacheStub('../src/services/handoffResetStore', {
  markReset(clientId) {
    resetMarks += 1;
    const checkpoint = { at: new Date().toISOString(), chatId: clientId };
    resetCheckpoints.set(Identity.getSessionKey(clientId), checkpoint);
    return checkpoint;
  },
  getResetCheckpoint(clientId) {
    return resetCheckpoints.get(Identity.getSessionKey(clientId)) || null;
  },
});
cacheStub('../src/services/botActivityStore', {
  getLastBotOutbound(clientId) { return checkpoints.get(Identity.getSessionKey(clientId)) || null; },
});
cacheStub('../src/core/decisionLogger', { decision() {}, decisionError() {} });

const historyState = new Map();
let listCalls = 0;
const { OutboundTracker } = require('../src/core/outboundTracker');
const tracker = new OutboundTracker();
const channel = {
  client: {
    async getAllMessagesInChat(chatId) { return historyState.get(chatId) || []; },
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
});

const buffer = { cleared: [], clear(id) { this.cleared.push(id); return 1; } };
const queue = { cancelled: [], cancelQueuedForChats(ids, code) { this.cancelled.push({ ids, code }); return 1; } };
runtime.buffers.add(buffer);
runtime.queues.add(queue);

const Safety = require('../src/core/handoffSafetyPreload');

(async () => {
  const customer = '5531999999999@c.us';
  const admin = '18885055098907@lid';

  labelState.set(customer, [{ name: 'Orçamento letreiros' }]);
  let guard = await SellerHandoff.getAutomationBlock(channel, customer);
  assert.equal(guard.blocked, false, 'etiqueta operacional não pode bloquear');

  Safety.invalidateLabelInspection(customer);
  labelState.set(customer, [{ name: 'Fornecedor' }]);
  guard = await SellerHandoff.getAutomationBlock(channel, customer);
  assert.equal(guard.blocked, true);
  assert.equal(guard.reason, 'manual_label');
  assert.ok(buffer.cleared.length > 0);
  assert.ok(queue.cancelled.length > 0);

  labelState.set(customer, [{ name: 'Orçamento letreiros' }]);
  Safety.invalidateLabelInspection(customer);
  guard = await SellerHandoff.getAutomationBlock(channel, customer);
  assert.equal(guard.blocked, false, 'remoção confirmada da etiqueta externa deve liberar o bloqueio de etiqueta');

  const manual = SellerHandoff.registerManualTakeover(customer, { source: 'onAnyMessage' });
  assert.equal(manual.blocked, true);
  assert.equal(manual.reason, 'manual_outbound_message');

  await assert.rejects(
    () => WppClient.createWppChannel().then((created) => created.sendText(customer, 'teste')),
    (error) => error.code === 'HUMAN_HANDOFF_BLOCKED',
  );

  const created = await WppClient.createWppChannel();
  await created.sendText(admin, 'mensagem do bot');
  await created.client.sendListMessage(admin, { title: 'Lista de teste' });
  assert.equal(listCalls, 1);
  const matchedList = tracker.consumeIfBot('5531971386091@c.us', {
    to: '5531971386091@c.us', type: 'list', body: 'Lista de teste',
  });
  assert.ok(matchedList, 'lista do bot precisa ser reconhecida entre aliases');

  const handler = SellerEvents.createSellerLabelUpdateHandler({ getChannel: () => created, delayMs: 0 });
  let event = await handler({
    data: { chatId: customer, type: 'add', labels: [{ name: 'Suporte' }] }, channel: created,
  });
  assert.equal(event.reason, 'MANAGED_SERVICE_LABEL');

  labelState.set(admin, [{ name: 'Fornecedor' }]);
  event = await handler({
    data: { chatId: admin, type: 'add', labels: [{ name: 'Fornecedor' }] }, channel: created,
  });
  assert.equal(event.assigned, true, 'perfil administrador precisa conseguir testar handoff por etiqueta');
  assert.equal(event.guard.reason, 'manual_label');
  assert.equal((await SellerHandoff.getAutomationBlock(channel, admin)).blocked, true);

  TesterRuntime.clearTesterConversationRuntime(admin);
  assert.equal(resetMarks, 1, 'reset deve gravar marco de histórico');
  labelState.set(admin, []);
  Safety.invalidateLabelInspection(admin);
  Safety.invalidateHistoryInspection(admin);
  guard = await SellerHandoff.getAutomationBlock(channel, admin);
  assert.equal(guard.blocked, false, 'reset deve limpar o handoff atual do administrador');

  const afterResetManual = SellerHandoff.registerManualTakeover(admin, { source: 'onAnyMessage' });
  assert.equal(afterResetManual.blocked, true, 'nova mensagem manual após reset precisa reativar handoff');
  TesterRuntime.clearTesterConversationRuntime(admin);
  assert.equal(resetMarks, 2);

  const resetAt = new Date(resetCheckpoints.get(Identity.getSessionKey(admin)).at).getTime();
  historyState.set(admin, [
    {
      id: 'human-before-reset',
      fromMe: true,
      type: 'chat',
      body: 'Mensagem antiga de vendedor',
      timestamp: Math.floor((resetAt - 5000) / 1000),
    },
  ]);
  Safety.invalidateHistoryInspection(admin);
  guard = await SellerHandoff.getAutomationBlock(channel, admin);
  assert.equal(guard.blocked, false, 'mensagem humana anterior ao /resetarsys deve ser ignorada');

  historyState.set(admin, [
    ...historyState.get(admin),
    {
      id: 'human-after-reset',
      fromMe: true,
      type: 'chat',
      body: 'Nova intervenção manual',
      timestamp: Math.floor((resetAt + 3000) / 1000),
    },
  ]);
  Safety.invalidateHistoryInspection(admin);
  guard = await SellerHandoff.getAutomationBlock(channel, admin);
  assert.equal(guard.blocked, true, 'mensagem humana posterior ao /resetarsys deve ativar handoff');
  assert.equal(guard.reason, 'manual_outbound_history');

  console.log('✅ Etiquetas e handoff verificados: administrador testa handoff normalmente; /resetarsys corta apenas o histórico anterior.');
})().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
