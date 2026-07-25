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

cacheStub('../src/config/env', {
  env: {
    serviceLabelReplaceGroup: [],
    sellerLabelRules: {},
    lidNumberMap: { '18885055098907@lid': '31971386091' },
  },
});
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
});

let actualCheckpoint = null;
const BotActivity = cacheStub('../src/services/botActivityStore', {
  getLastBotOutbound() { return actualCheckpoint; },
});
let resetCheckpoint = null;
cacheStub('../src/services/handoffResetStore', {
  getResetCheckpoint() { return resetCheckpoint; },
});
const blocks = new Map();
const HumanControl = cacheStub('../src/services/humanControlStore', {
  setBlock(clientId, payload) { blocks.set(Identity.getSessionKey(clientId), payload); return payload; },
  clearBlock(clientId) { return blocks.delete(Identity.getSessionKey(clientId)); },
});
const Access = cacheStub('../src/core/testCommandAccess', {
  isTesterIdentity() { return false; },
});
cacheStub('../src/core/decisionLogger', { decision() {} });

const History = require('../src/core/handoffHistoryPolicyPreload');

assert.equal(
  BotActivity.getLastBotOutbound('5531999999999@c.us'),
  null,
  'fora da inspeção de handoff o checkpoint real deve ser preservado',
);
const noCheckpoint = History.withHandoffHistoryBoundary(
  () => BotActivity.getLastBotOutbound('5531999999999@c.us'),
);
assert.ok(noCheckpoint?.synthetic);
assert.equal(noCheckpoint.type, 'startup_handoff_boundary');

actualCheckpoint = { at: new Date(Date.now() - 5000).toISOString(), messageId: 'bot-1', type: 'text' };
assert.equal(BotActivity.getLastBotOutbound('5531999999999@c.us').messageId, 'bot-1');
resetCheckpoint = { at: new Date(Date.now() + 1000).toISOString() };
const resetWins = History.withHandoffHistoryBoundary(
  () => BotActivity.getLastBotOutbound('18885055098907@lid'),
);
assert.equal(resetWins.type, 'resetarsys_handoff_boundary');

assert.equal(Access.isTesterIdentity({ from: '18885055098907@lid' }), true);
assert.equal(
  Access.isTesterIdentity({ from: '5531999999999@c.us' }),
  false,
  'whitelist geral não pode virar tester',
);
const ignored = HumanControl.setBlock('18885055098907@lid', { reason: 'manual_outbound_history' });
assert.equal(ignored.bypassed, true);
assert.equal(blocks.size, 0);
HumanControl.setBlock('5531999999999@c.us', { reason: 'manual_outbound_message' });
assert.equal(blocks.size, 1);

console.log('✅ Histórico de handoff verificado: corte contextual, reset persistente e tester estrita.');
