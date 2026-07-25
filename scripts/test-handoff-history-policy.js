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

const env = {
  runtimeCacheTtlMs: 120000,
  unreadRecoveryHistoryLimit: 120,
  unreadBootstrapAttempts: 1,
  unreadBootstrapRetryDelayMs: 1,
  unreadBootstrapMaxChats: 30,
  unreadBootstrapMaxMessagesPerChat: 8,
  serviceLabelReplaceGroup: [],
  sellerLabelRules: {},
  lidNumberMap: { '18885055098907@lid': '31971386091' },
};
cacheStub('../src/config/env', { env });
const Identity = cacheStub('../src/services/contactIdentity', {
  normalizeChatId(value) {
    const raw = String(value && typeof value === 'object' ? (value._serialized || '') : value || '').trim().toLowerCase();
    if (/@(?:c\.us|lid)$/.test(raw)) return raw;
    const digits = raw.replace(/\D/g, '');
    return digits ? `${digits}@c.us` : '';
  },
  getLabelCandidateIds(value) {
    const direct = this.normalizeChatId(value);
    if (direct === '18885055098907@lid' || direct === '5531971386091@c.us') {
      return ['18885055098907@lid', '5531971386091@c.us'];
    }
    return [direct].filter(Boolean);
  },
  getSessionKey(value) { return `wa:${this.getLabelCandidateIds(value)[0] || ''}`; },
  registerContact({ chatId }) { return { primaryChatId: this.normalizeChatId(chatId) }; },
});

const blocks = new Map();
const HumanControl = cacheStub('../src/services/humanControlStore', {
  setBlock(clientId, payload) { blocks.set(Identity.getSessionKey(clientId), payload); return payload; },
  getBlock(clientId) {
    const value = blocks.get(Identity.getSessionKey(clientId));
    return value ? { blocked: true, control: value } : { blocked: false, control: null };
  },
  clearBlock(clientId) { return blocks.delete(Identity.getSessionKey(clientId)); },
});
cacheStub('../src/services/leadStore', { resetSystem() { return {}; } });
cacheStub('../src/services/botActivityStore', {
  getLastBotOutbound() { return null; },
  markBotOutbound() {},
  resetAll() {},
});
let reset = null;
cacheStub('../src/services/handoffResetStore', { getResetCheckpoint() { return reset; } });
cacheStub('../src/services/wppconnectClient', { collectUnreadMessages: async () => [] });
cacheStub('../src/core/sellerHandoff', { getAutomationBlock: async () => ({ blocked: false }) });
cacheStub('../src/core/outboundTracker', { OutboundTracker: function OutboundTracker() {} });
cacheStub('../src/flow/customerFlow', { processCustomerMessage: async () => null });
cacheStub('../src/core/decisionLogger', { decision() {} });
cacheStub('../src/core/testCommandAccess', { isTesterIdentity() { return false; } });

const Runtime = require('../src/core/runtimeReliabilityPreload');

function outgoing(at, id = 'out') {
  return {
    fromMe: true,
    type: 'chat',
    body: 'mensagem humana',
    timestamp: Math.floor(new Date(at).getTime() / 1000),
    id: { _serialized: id },
  };
}

const old = new Date(Date.now() - 60000).toISOString();
let inspection = Runtime.findManualOutboundAfterCheckpoint([outgoing(old)], null, {});
assert.equal(inspection.found, false);
assert.equal(inspection.reason, 'sem_checkpoint_inconclusivo');

const resetAt = new Date(Date.now() - 30000).toISOString();
reset = { at: resetAt };
inspection = Runtime.findManualOutboundAfterCheckpoint([outgoing(old)], null, { resetAt });
assert.equal(inspection.found, false, 'histórico anterior ao reset deve ser ignorado');
const afterReset = new Date(Date.now() - 5000).toISOString();
inspection = Runtime.findManualOutboundAfterCheckpoint([outgoing(afterReset)], null, { resetAt });
assert.equal(inspection.found, true);
assert.equal(inspection.reason, 'manual_outbound_history');

const checkpointAt = new Date(Date.now() - 20000).toISOString();
inspection = Runtime.findManualOutboundAfterCheckpoint([
  {
    fromMe: false,
    type: 'chat',
    body: 'cliente',
    timestamp: Math.floor(new Date(checkpointAt).getTime() / 1000),
    id: { _serialized: 'bot-1' },
  },
  outgoing(afterReset, 'human-1'),
], { at: checkpointAt, messageId: 'bot-1' }, {});
assert.equal(inspection.found, true);

const Access = require('../src/core/testCommandAccess');
require('../src/core/handoffHistoryPolicyPreload');
assert.equal(Access.isTesterIdentity({ from: '18885055098907@lid' }), true);
assert.equal(Access.isTesterIdentity({ from: '5531999999999@c.us' }), false, 'whitelist geral não pode virar tester');
const ignored = HumanControl.setBlock('18885055098907@lid', { reason: 'manual_outbound_history' });
assert.equal(ignored.bypassed, true);
HumanControl.setBlock('5531999999999@c.us', { reason: 'manual_outbound_message' });
assert.equal(blocks.size, 1);

console.log('✅ Histórico de handoff verificado: ausência é inconclusiva, reset corta o passado e só saída posterior bloqueia.');
