'use strict';

const WppClient = require('../services/wppconnectClient');
const RequiredLabels = require('./requiredLabelsStartup');
const ReconnectRecovery = require('./unreadReconnectRecovery');

const DEFAULT_CORE_TIMEOUT_MS = 60000;
const DEFAULT_LABEL_TIMEOUT_MS = 30000;
const DEFAULT_POLL_MS = 500;

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms || 0))));
}

async function inspectSynchronization(client) {
  if (!client?.page?.evaluate) {
    return {
      coreReady: false,
      labelsReady: false,
      reason: 'PAGE_UNAVAILABLE',
    };
  }

  try {
    return await client.page.evaluate(() => {
      const WPP = window.WPP || null;
      const Store = window.Store || null;
      const documentReady = document?.readyState === 'complete';
      const chatApiReady = Boolean(
        WPP?.chat
        && (
          typeof WPP.chat.getMessages === 'function'
          || typeof WPP.chat.getAllChats === 'function'
          || typeof WPP.chat.list === 'function'
        )
      );
      const storeReady = Boolean(Store?.Chat);
      const labelsReady = Boolean(
        typeof WPP?.labels?.getAllLabels === 'function'
        && typeof WPP?.lists?.create === 'function'
      );

      return {
        coreReady: Boolean(documentReady && WPP && chatApiReady && storeReady),
        labelsReady,
        documentReady,
        hasWpp: Boolean(WPP),
        hasChatApi: chatApiReady,
        hasStoreChat: storeReady,
      };
    });
  } catch (error) {
    return {
      coreReady: false,
      labelsReady: false,
      reason: error?.message || String(error),
    };
  }
}

async function waitForSynchronization(client, {
  requireLabels = false,
  timeoutMs = requireLabels
    ? positiveNumber(process.env.WPP_LABEL_READY_TIMEOUT_MS, DEFAULT_LABEL_TIMEOUT_MS)
    : positiveNumber(process.env.WPP_SYNC_READY_TIMEOUT_MS, DEFAULT_CORE_TIMEOUT_MS),
  pollMs = positiveNumber(process.env.WPP_SYNC_POLL_MS, DEFAULT_POLL_MS),
} = {}) {
  const startedAt = Date.now();
  const deadline = startedAt + Math.max(1, Number(timeoutMs || 0));
  let last = null;

  do {
    last = await inspectSynchronization(client);
    if (last.coreReady && (!requireLabels || last.labelsReady)) {
      return {
        ...last,
        ready: true,
        waitedMs: Date.now() - startedAt,
      };
    }
    await wait(pollMs);
  } while (Date.now() < deadline);

  return {
    ...(last || {}),
    ready: false,
    waitedMs: Date.now() - startedAt,
    reason: last?.reason || (requireLabels ? 'LABEL_API_TIMEOUT' : 'WPP_CORE_TIMEOUT'),
  };
}

function readinessSummary(result = {}) {
  return [
    `core=${result.coreReady ? 'ok' : 'pendente'}`,
    `labels=${result.labelsReady ? 'ok' : 'pendente'}`,
    `espera=${Number(result.waitedMs || 0)}ms`,
    result.reason ? `motivo=${result.reason}` : null,
  ].filter(Boolean).join(' | ');
}

function installSynchronizationGuard() {
  if (WppClient.__personalizeSynchronizationGuardInstalled) return;

  // SYNCING e RESUMING ainda não significam que as APIs da página estão prontas.
  // A recuperação só é disparada após CONNECTED e ainda passa pela sondagem abaixo.
  ReconnectRecovery.CONNECTED_STATES.delete('SYNCING');
  ReconnectRecovery.CONNECTED_STATES.delete('RESUMING');

  const originalCreateWppChannel = WppClient.createWppChannel.bind(WppClient);
  WppClient.createWppChannel = async function createWppChannelWithSynchronizationGuard(options = {}) {
    const channel = await originalCreateWppChannel(options);
    channel.waitForSynchronization = (settings = {}) => waitForSynchronization(channel.client, settings);

    const readiness = await channel.waitForSynchronization({ requireLabels: false });
    if (!readiness.ready) {
      const error = new Error(`WhatsApp não ficou operacional dentro do prazo: ${readinessSummary(readiness)}`);
      error.code = 'WPP_SYNC_TIMEOUT';
      error.readiness = readiness;
      throw error;
    }

    console.log(`[SINCRONIZAÇÃO] transporte e APIs principais prontos | ${readinessSummary(readiness)}`);
    return channel;
  };

  const originalCollectUnreadMessages = WppClient.collectUnreadMessages.bind(WppClient);
  WppClient.collectUnreadMessages = async function collectUnreadMessagesWhenReady(client) {
    const readiness = await waitForSynchronization(client, { requireLabels: false });
    if (!readiness.ready) {
      console.warn(`[RECUPERAÇÃO] varredura adiada porque o WhatsApp ainda não está pronto | ${readinessSummary(readiness)}`);
      return [];
    }
    return originalCollectUnreadMessages(client);
  };

  const originalEnsureRequiredLabelsOnce = RequiredLabels.ensureRequiredLabelsOnce.bind(RequiredLabels);
  RequiredLabels.ensureRequiredLabelsOnce = async function ensureRequiredLabelsAfterSynchronization(channel) {
    const client = channel?.client;
    if (!client) return false;
    if (client.__personalizeRequiredLabelsReady === true) return true;
    if (client.__personalizeRequiredLabelsPromise) return client.__personalizeRequiredLabelsPromise;

    client.__personalizeRequiredLabelsPromise = (async () => {
      const readiness = await waitForSynchronization(client, { requireLabels: true });
      if (!readiness.ready) {
        console.warn(`[LISTAS][INÍCIO] manutenção adiada; API de etiquetas ainda indisponível | ${readinessSummary(readiness)}`);
        return false;
      }

      const result = await originalEnsureRequiredLabelsOnce(channel);
      if (result === true) client.__personalizeRequiredLabelsReady = true;
      return result === true;
    })();

    try {
      return await client.__personalizeRequiredLabelsPromise;
    } finally {
      if (client.__personalizeRequiredLabelsReady !== true) {
        delete client.__personalizeRequiredLabelsPromise;
      }
    }
  };

  WppClient.__personalizeSynchronizationGuardInstalled = true;
}

installSynchronizationGuard();

module.exports = {
  inspectSynchronization,
  installSynchronizationGuard,
  readinessSummary,
  waitForSynchronization,
};
