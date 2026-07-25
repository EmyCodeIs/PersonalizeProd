'use strict';

const assert = require('node:assert/strict');

async function run() {
  process.env.WPP_SYNC_READY_TIMEOUT_MS = '100';
  process.env.WPP_LABEL_READY_TIMEOUT_MS = '100';
  process.env.WPP_SYNC_POLL_MS = '1';

  const WppClient = require('../src/services/wppconnectClient');
  const RequiredLabels = require('../src/core/requiredLabelsStartup');
  const ReconnectRecovery = require('../src/core/unreadReconnectRecovery');
  const preloadPath = require.resolve('../src/core/synchronizationGuardPreload');

  const originals = {
    createWppChannel: WppClient.createWppChannel,
    collectUnreadMessages: WppClient.collectUnreadMessages,
    ensureRequiredLabelsOnce: RequiredLabels.ensureRequiredLabelsOnce,
    connectedStates: new Set(ReconnectRecovery.CONNECTED_STATES),
  };

  let probeCount = 0;
  let labelRuns = 0;
  const client = {
    page: {
      evaluate: async () => {
        probeCount += 1;
        if (probeCount === 1) {
          return { coreReady: false, labelsReady: false, reason: 'SYNCING' };
        }
        if (probeCount === 2) {
          return { coreReady: true, labelsReady: false };
        }
        return { coreReady: true, labelsReady: true };
      },
    },
  };

  try {
    WppClient.createWppChannel = async () => ({ client });
    WppClient.collectUnreadMessages = async () => [{ from: 'teste@c.us', text: 'oi' }];
    RequiredLabels.ensureRequiredLabelsOnce = async () => {
      labelRuns += 1;
      return true;
    };
    delete WppClient.__personalizeSynchronizationGuardInstalled;
    delete require.cache[preloadPath];

    const {
      waitForSynchronization,
    } = require('../src/core/synchronizationGuardPreload');

    const channel = await WppClient.createWppChannel({});
    assert.equal(typeof channel.waitForSynchronization, 'function');
    assert.ok(probeCount >= 2, 'a conexão precisa aguardar as APIs principais');

    assert.equal(await RequiredLabels.ensureRequiredLabelsOnce(channel), true);
    assert.equal(await RequiredLabels.ensureRequiredLabelsOnce(channel), true);
    assert.equal(labelRuns, 1, 'a manutenção de etiquetas deve executar uma única vez');

    const unread = await WppClient.collectUnreadMessages(client);
    assert.equal(unread.length, 1);
    assert.equal(ReconnectRecovery.CONNECTED_STATES.has('SYNCING'), false);
    assert.equal(ReconnectRecovery.CONNECTED_STATES.has('RESUMING'), false);
    assert.equal(ReconnectRecovery.CONNECTED_STATES.has('CONNECTED'), true);

    const timedOut = await waitForSynchronization({
      page: { evaluate: async () => ({ coreReady: false, labelsReady: false }) },
    }, { timeoutMs: 5, pollMs: 1 });
    assert.equal(timedOut.ready, false);
    assert.equal(timedOut.reason, 'WPP_CORE_TIMEOUT');

    console.log('✅ Sincronização verificada: prontidão real, etiquetas únicas e recuperação após CONNECTED.');
  } finally {
    WppClient.createWppChannel = originals.createWppChannel;
    WppClient.collectUnreadMessages = originals.collectUnreadMessages;
    RequiredLabels.ensureRequiredLabelsOnce = originals.ensureRequiredLabelsOnce;
    ReconnectRecovery.CONNECTED_STATES.clear();
    for (const state of originals.connectedStates) ReconnectRecovery.CONNECTED_STATES.add(state);
    delete WppClient.__personalizeSynchronizationGuardInstalled;
    delete require.cache[preloadPath];
    delete process.env.WPP_SYNC_READY_TIMEOUT_MS;
    delete process.env.WPP_LABEL_READY_TIMEOUT_MS;
    delete process.env.WPP_SYNC_POLL_MS;
  }
}

run().catch((error) => {
  console.error('❌ Teste de sincronização falhou:', error?.stack || error?.message || error);
  process.exitCode = 1;
});
