'use strict';

const assert = require('node:assert/strict');

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms || 0))));
}

async function run() {
  process.env.WPP_SYNC_READY_TIMEOUT_MS = '100';
  process.env.WPP_LABEL_READY_TIMEOUT_MS = '100';
  process.env.WPP_READINESS_TIMEOUT_MS = '100';
  process.env.WPP_RECOVERY_READY_TIMEOUT_MS = '10';
  process.env.WPP_SYNC_POLL_MS = '1';
  process.env.WPP_READINESS_POLL_MS = '1';
  process.env.WPP_STARTUP_RELEASE_TIMEOUT_MS = '100';
  process.env.WPP_STARTUP_RELEASE_POLL_MS = '1';

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
  let stateProbeCount = 0;
  let labelRuns = 0;
  let deliveredIncoming = 0;
  let deliveredOutgoing = 0;
  const client = {
    getState: async () => {
      stateProbeCount += 1;
      return stateProbeCount < 2 ? 'SYNCING' : 'CONNECTED';
    },
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
    WppClient.createWppChannel = async (options = {}) => {
      await options.onMessage?.({ from: 'teste@c.us', text: 'chegou durante syncing' });
      await options.onOutgoingMessage?.({ from: 'teste@c.us', text: 'saída durante syncing' });
      return { client };
    };
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

    const channel = await WppClient.createWppChannel({
      onMessage: async () => { deliveredIncoming += 1; },
      onOutgoingMessage: async () => { deliveredOutgoing += 1; },
    });

    assert.equal(typeof channel.waitForSynchronization, 'function');
    assert.equal(typeof channel.waitForOperationalConnection, 'function');
    assert.equal(typeof channel.releaseStartupMessages, 'function');
    assert.ok(probeCount >= 2, 'a conexão precisa aguardar as APIs principais');
    assert.ok(stateProbeCount >= 2, 'a conexão precisa sair de SYNCING antes de ser operacional');
    assert.equal(deliveredIncoming, 0, 'entrada não pode processar durante a sincronização');
    assert.equal(deliveredOutgoing, 0, 'saída não pode virar handoff durante a sincronização');
    assert.equal(channel.startupMessageGate.pendingCount(), 2);

    await assert.rejects(
      () => WppClient.collectUnreadMessages(client),
      (error) => error?.code === 'WPP_RECOVERY_NOT_READY',
      'a recuperação deve aguardar a liberação completa da aplicação',
    );

    channel.__messageExperienceInstalled = true;
    const released = await channel.releaseStartupMessages();
    assert.equal(released.delivered, 2);
    assert.equal(deliveredIncoming, 1);
    assert.equal(deliveredOutgoing, 1);
    assert.equal(channel.startupMessageGate.pendingCount(), 0);

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

    let recoveryCalls = 0;
    let recoveryDelivered = 0;
    const recovery = ReconnectRecovery.createRecoveryRunner({
      collectUnreadMessages: async () => {
        recoveryCalls += 1;
        if (recoveryCalls === 1) {
          const error = new Error('ainda sincronizando');
          error.code = 'WPP_RECOVERY_NOT_READY';
          throw error;
        }
        return [{ from: 'teste@c.us', text: 'recuperada', raw: {} }];
      },
      onMessage: async () => { recoveryDelivered += 1; },
      getClient: () => client,
      delayMs: 1,
      retryDelayMs: 1,
      logger: { log() {}, warn() {} },
    });

    const firstRecovery = await recovery.run('teste');
    assert.equal(firstRecovery.retryScheduled, true);
    await wait(25);
    assert.ok(recoveryCalls >= 2, 'a recuperação precisa tentar novamente depois da prontidão incompleta');
    assert.equal(recoveryDelivered, 1);
    recovery.dispose();

    console.log('✅ Sincronização fechada: APIs, estado operacional, trava inicial e retry de recuperação verificados.');
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
    delete process.env.WPP_READINESS_TIMEOUT_MS;
    delete process.env.WPP_RECOVERY_READY_TIMEOUT_MS;
    delete process.env.WPP_SYNC_POLL_MS;
    delete process.env.WPP_READINESS_POLL_MS;
    delete process.env.WPP_STARTUP_RELEASE_TIMEOUT_MS;
    delete process.env.WPP_STARTUP_RELEASE_POLL_MS;
  }
}

run().catch((error) => {
  console.error('❌ Teste de sincronização falhou:', error?.stack || error?.message || error);
  process.exitCode = 1;
});
