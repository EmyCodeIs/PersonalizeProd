'use strict';

const assert = require('node:assert/strict');

function cacheStub(relative, exports) {
  const filename = require.resolve(relative);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
  return exports;
}

process.env.HANDOFF_STARTUP_RECONCILE_DELAY_MS = '600000';
process.env.HANDOFF_STARTUP_RECONCILE_MAX = '10';
process.env.HANDOFF_SLEEP_LOG_TTL_MS = '600000';

const blocks = new Map();
const supported = new Set([
  'seller_label',
  'manual_label',
  'manual_outbound_message',
  'manual_outbound_history',
]);

const HumanControl = cacheStub('../src/services/humanControlStore', {
  getBlock(clientId) {
    const control = blocks.get(String(clientId));
    return control ? { blocked: true, control } : { blocked: false, control: null };
  },
  setBlock(clientId, payload) {
    blocks.set(String(clientId), { ...payload });
    return blocks.get(String(clientId));
  },
  clearBlock(clientId) {
    return blocks.delete(String(clientId));
  },
  listBlocks() {
    return [...blocks.entries()].map(([clientId, control]) => ({ clientId, ...control }));
  },
});

cacheStub('../src/core/handoffPolicy', {
  isStrictTesterIdentity() { return false; },
  isSupportedHandoffReason(reason) { return supported.has(String(reason || '')); },
});

const decisions = [];
cacheStub('../src/core/decisionLogger', {
  decision(scope, event, details) { decisions.push({ scope, event, details }); },
  decisionError(scope, error, details) { decisions.push({ scope, event: 'error', error, details }); },
});

let remoteChecks = 0;
const externalState = new Map();
const SellerHandoff = cacheStub('../src/core/sellerHandoff', {
  async getAutomationBlock(_channel, clientId) {
    remoteChecks += 1;
    const key = String(clientId);
    if (externalState.get(key) === 'removed') {
      blocks.delete(key);
      return { blocked: false, reason: null, source: 'external_label_removed' };
    }
    const control = blocks.get(key);
    return control
      ? { blocked: true, reason: control.reason, seller: control.seller || null, labelName: control.labelName || null, source: control.source || 'human_control', details: control }
      : { blocked: false, reason: null, source: 'remote_free' };
  },
});

let registeredOptions = null;
const WppClient = cacheStub('../src/services/wppconnectClient', {
  async createWppChannel(options = {}) {
    registeredOptions = options;
    return { client: {} };
  },
});

const Sleep = require('../src/core/handoffSleepPreload');

(async () => {
  blocks.set('manual@c.us', {
    reason: 'manual_outbound_message',
    source: 'manual_outbound_message',
  });
  blocks.set('label@c.us', {
    reason: 'seller_label',
    source: 'external_label_event',
    seller: 'Ana',
    labelName: 'Ana',
  });

  const local = SellerHandoff.getLocalAutomationBlock('manual@c.us');
  assert.equal(local.blocked, true);
  assert.equal(local.localOnly, true);

  let guard = await SellerHandoff.getAutomationBlock(null, 'label@c.us');
  assert.equal(guard.blocked, true);
  assert.equal(remoteChecks, 0, 'handoff persistente não deve consultar WhatsApp em leitura comum');

  externalState.set('label@c.us', 'removed');
  guard = await SellerHandoff.getAutomationBlock(null, 'label@c.us', { forceExternalRefresh: true });
  assert.equal(guard.blocked, false, 'reconciliação explícita deve liberar etiqueta removida');
  assert.equal(remoteChecks, 1);

  let delivered = 0;
  await WppClient.createWppChannel({
    async onMessage() {
      delivered += 1;
      return { delivered: true };
    },
  });

  const sleeping = await registeredOptions.onMessage({ from: 'manual@c.us', text: 'Ainda preciso de ajuda' });
  assert.equal(sleeping.ignored, true);
  assert.equal(delivered, 0, 'contato em handoff deve parar antes do processador principal');

  await registeredOptions.onMessage({ from: 'manual@c.us', text: '/resetarsys' });
  assert.equal(delivered, 1, '/resetarsys precisa atravessar o fast path para a validação administrativa');

  await registeredOptions.onMessage({ from: 'free@c.us', text: 'Olá' });
  assert.equal(delivered, 2, 'contato livre deve continuar no fluxo normal');

  blocks.set('label-startup@c.us', {
    reason: 'manual_label',
    source: 'external_label_event',
    labelName: 'Fornecedor',
  });
  blocks.set('manual-startup@c.us', {
    reason: 'manual_outbound_history',
    source: 'history_guard',
  });
  externalState.set('label-startup@c.us', 'removed');

  const beforeReconcileChecks = remoteChecks;
  const reconciliation = await Sleep.reconcilePersistentHandoffs({ client: {} }, { limit: 10 });
  assert.equal(reconciliation.checked, 1, 'startup deve reconciliar apenas bloqueios ligados a etiquetas');
  assert.equal(reconciliation.released, 1);
  assert.equal(blocks.has('label-startup@c.us'), false);
  assert.equal(blocks.has('manual-startup@c.us'), true, 'handoff por mensagem humana deve continuar persistente');
  assert.equal(remoteChecks, beforeReconcileChecks + 1);

  assert.ok(
    decisions.some((item) => item.event === 'contato_adormecido_na_entrada'),
    'deve existir log resumido e limitado do fast path',
  );

  console.log('✅ Handoff adormecido: bloqueio local evita runtime e reconciliação explícita preserva liberação por etiqueta.');
})().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
