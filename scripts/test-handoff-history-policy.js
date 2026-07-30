'use strict';

const assert = require('node:assert/strict');

function cacheStub(relative, exports) {
  const filename = require.resolve(relative);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
  return exports;
}

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

const History = require('../src/core/handoffHistoryPolicyPreload');

assert.equal(BotActivity.getLastBotOutbound('5531999999999@c.us'), null);
const noCheckpoint = History.withHandoffHistoryBoundary(
  () => BotActivity.getLastBotOutbound('5531999999999@c.us'),
);
assert.ok(noCheckpoint?.synthetic);
assert.equal(noCheckpoint.type, 'startup_handoff_boundary');

actualCheckpoint = { at: new Date(Date.now() - 5000).toISOString(), messageId: 'bot-1', type: 'text' };
const actualWins = History.withHandoffHistoryBoundary(
  () => BotActivity.getLastBotOutbound('5531999999999@c.us'),
);
assert.equal(actualWins.messageId, 'bot-1', 'checkpoint real deve continuar válido após reinício');

resetCheckpoint = { at: new Date(Date.now() + 1000).toISOString() };
const resetWins = History.withHandoffHistoryBoundary(
  () => BotActivity.getLastBotOutbound('18885055098907@lid'),
);
assert.equal(resetWins.type, 'resetarsys_handoff_boundary');

actualCheckpoint = { at: new Date(Date.now() + 3000).toISOString(), messageId: 'bot-after-reset', type: 'text' };
const botAfterResetWins = History.withHandoffHistoryBoundary(
  () => BotActivity.getLastBotOutbound('18885055098907@lid'),
);
assert.equal(botAfterResetWins.messageId, 'bot-after-reset');

assert.equal(
  History.newestCheckpoint(
    { at: '2026-07-30T10:00:00.000Z', type: 'resetarsys_handoff_boundary' },
    { at: '2026-07-30T10:00:02.000Z', messageId: 'bot-new' },
  ).messageId,
  'bot-new',
);

console.log('✅ Histórico de handoff verificado: reinício preserva checkpoint e /resetarsys ignora somente mensagens anteriores.');
