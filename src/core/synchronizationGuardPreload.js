'use strict';

const WppClient = require('../services/wppconnectClient');
const RequiredLabels = require('./requiredLabelsStartup');
const ReconnectRecovery = require('./unreadReconnectRecovery');
const { decision } = require('./decisionLogger');

const DEFAULT_CORE_TIMEOUT_MS = 60000;
const DEFAULT_LABEL_TIMEOUT_MS = 30000;
const DEFAULT_OPERATIONAL_TIMEOUT_MS = 900000;
const DEFAULT_RECOVERY_TIMEOUT_MS = 15000;
const DEFAULT_STARTUP_RELEASE_TIMEOUT_MS = 120000;
const DEFAULT_STARTUP_MAX_PENDING = 200;
const DEFAULT_POLL_MS = 500;
const OPERATIONAL_STATES = new Set(['CONNECTED', 'MAIN', 'NORMAL', 'INCHAT', 'IN_CHAT']);

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms || 0))));
}

function normalizeConnectionState(value) {
  return String(value || '').trim().toUpperCase();
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

async function inspectOperationalConnection(channel) {
  let state = '';
  try {
    state = normalizeConnectionState(await channel?.client?.getState?.());
  } catch (_) {}

  if (!state && channel?.client?.page?.evaluate) {
    try {
      state = normalizeConnectionState(await channel.client.page.evaluate(() => (
        window.Store?.Stream?.mode
        || window.Store?.Stream?.state
        || ''
      )));
    } catch (_) {}
  }

  return {
    state,
    operational: OPERATIONAL_STATES.has(state),
  };
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

async function waitForOperationalConnection(channel, {
  timeoutMs = positiveNumber(
    process.env.WPP_READINESS_TIMEOUT_MS || process.env.WPP_SYNC_READY_TIMEOUT_MS,
    DEFAULT_OPERATIONAL_TIMEOUT_MS,
  ),
  pollMs = positiveNumber(
    process.env.WPP_READINESS_POLL_MS || process.env.WPP_SYNC_POLL_MS,
    DEFAULT_POLL_MS,
  ),
} = {}) {
  const startedAt = Date.now();
  const deadline = startedAt + Math.max(1, Number(timeoutMs || 0));
  let last = { state: '', operational: false };

  do {
    last = await inspectOperationalConnection(channel);
    if (last.operational) {
      return {
        ...last,
        ready: true,
        waitedMs: Date.now() - startedAt,
      };
    }
    await wait(pollMs);
  } while (Date.now() < deadline);

  return {
    ...last,
    ready: false,
    waitedMs: Date.now() - startedAt,
    reason: 'WPP_CONNECTION_TIMEOUT',
  };
}

function readinessSummary(result = {}) {
  return [
    `core=${result.coreReady ? 'ok' : 'pendente'}`,
    result.state !== undefined ? `estado=${result.state || 'pendente'}` : null,
    result.labelsReady !== undefined ? `labels=${result.labelsReady ? 'ok' : 'pendente'}` : null,
    `espera=${Number(result.waitedMs || 0)}ms`,
    result.reason ? `motivo=${result.reason}` : null,
  ].filter(Boolean).join(' | ');
}

function createStartupMessageGate({
  maxPending = positiveNumber(process.env.WPP_STARTUP_MAX_PENDING, DEFAULT_STARTUP_MAX_PENDING),
} = {}) {
  let open = false;
  let flushing = false;
  let dropped = 0;
  const pending = [];

  function queue(handler, payload, kind) {
    if (pending.length >= maxPending) {
      pending.shift();
      dropped += 1;
      console.warn(`[SINCRONIZAÇÃO] limite da espera inicial atingido; evento mais antigo descartado | limite=${maxPending}`);
    }
    pending.push({ handler, payload, kind, queuedAt: Date.now() });
    console.log(`[SINCRONIZAÇÃO] ${kind} retida até o sistema ficar pronto | pendentes=${pending.length}`);
  }

  function wrap(handler, kind = 'evento') {
    if (typeof handler !== 'function') return handler;
    return async function guardedStartupHandler(payload = {}) {
      if (open && !flushing) return handler(payload);
      queue(handler, payload, kind);
      return undefined;
    };
  }

  async function release() {
    if (open && !flushing && pending.length === 0) {
      return { delivered: 0, dropped, pending: 0 };
    }

    open = true;
    if (flushing) return { delivered: 0, dropped, pending: pending.length, alreadyFlushing: true };

    flushing = true;
    let delivered = 0;
    try {
      while (pending.length) {
        const item = pending.shift();
        try {
          await item.handler(item.payload);
          delivered += 1;
        } catch (error) {
          console.warn(
            `[SINCRONIZAÇÃO] falha ao liberar ${item.kind} retida | erro=${error?.message || error}`,
          );
        }
      }
    } finally {
      flushing = false;
    }

    console.log(`[SINCRONIZAÇÃO] atendimento liberado | eventosEntregues=${delivered} | descartados=${dropped}`);
    return { delivered, dropped, pending: pending.length };
  }

  return {
    isOpen: () => open,
    pendingCount: () => pending.length,
    release,
    wrap,
  };
}

function scheduleStartupGateRelease(channel, gate) {
  if (!channel || !gate || channel.__personalizeStartupGateReleaseScheduled) return;
  channel.__personalizeStartupGateReleaseScheduled = true;

  const startedAt = Date.now();
  const timeoutMs = positiveNumber(
    process.env.WPP_STARTUP_RELEASE_TIMEOUT_MS,
    DEFAULT_STARTUP_RELEASE_TIMEOUT_MS,
  );
  const pollMs = Math.min(250, positiveNumber(process.env.WPP_STARTUP_RELEASE_POLL_MS, 25));

  const check = () => {
    if (gate.isOpen()) return;
    const applicationInstalled = Boolean(
      channel.__messageExperienceInstalled
      || channel.__decisionChannelInstrumentationInstalled
    );
    const timedOut = Date.now() - startedAt >= timeoutMs;

    if (applicationInstalled || timedOut) {
      if (timedOut && !applicationInstalled) {
        console.warn('[SINCRONIZAÇÃO] liberando espera inicial pelo limite de segurança; instrumentação ainda não confirmou instalação.');
      }
      setImmediate(() => {
        void channel.releaseStartupMessages?.().catch((error) => {
          console.warn('[SINCRONIZAÇÃO] falha ao liberar eventos iniciais:', error?.message || error);
        });
      });
      return;
    }

    const timer = setTimeout(check, pollMs);
    timer.unref?.();
  };

  check();
}

function recoveryNotReadyError(reason, details = {}) {
  const error = new Error(reason || 'WPP_RECOVERY_NOT_READY');
  error.code = 'WPP_RECOVERY_NOT_READY';
  error.details = details;
  return error;
}

function installSynchronizationGuard() {
  if (WppClient.__personalizeSynchronizationGuardInstalled) return;

  ReconnectRecovery.CONNECTED_STATES.delete('SYNCING');
  ReconnectRecovery.CONNECTED_STATES.delete('RESUMING');

  const originalCreateWppChannel = WppClient.createWppChannel.bind(WppClient);
  WppClient.createWppChannel = async function createWppChannelWithSynchronizationGuard(options = {}) {
    const startupGate = createStartupMessageGate();
    const guardedOptions = {
      ...options,
      onMessage: startupGate.wrap(options.onMessage, 'mensagem recebida'),
      onOutgoingMessage: startupGate.wrap(options.onOutgoingMessage, 'mensagem enviada'),
    };

    const channel = await originalCreateWppChannel(guardedOptions);
    channel.waitForSynchronization = (settings = {}) => waitForSynchronization(channel.client, settings);
    channel.waitForOperationalConnection = (settings = {}) => waitForOperationalConnection(channel, settings);

    const readiness = await channel.waitForSynchronization({ requireLabels: false });
    if (!readiness.ready) {
      const error = new Error(`WhatsApp não ficou operacional dentro do prazo: ${readinessSummary(readiness)}`);
      error.code = 'WPP_SYNC_TIMEOUT';
      error.readiness = readiness;
      throw error;
    }

    const operational = await channel.waitForOperationalConnection();
    if (!operational.ready) {
      const error = new Error(`WhatsApp não confirmou estado operacional: ${readinessSummary(operational)}`);
      error.code = 'WPP_CONNECTION_TIMEOUT';
      error.readiness = operational;
      throw error;
    }

    if (channel.client) channel.client.__personalizeStartupGateClosed = true;
    channel.releaseStartupMessages = async () => {
      if (channel.client) channel.client.__personalizeStartupGateClosed = false;
      return startupGate.release();
    };
    channel.startupMessageGate = {
      isOpen: startupGate.isOpen,
      pendingCount: startupGate.pendingCount,
    };

    decision('CONEXÃO', 'estado_operacional_confirmado', {
      status: operational.state,
      sessão: process.env.WPP_SESSION_NAME || 'personalize-wppconnect',
    });
    console.log(
      `[SINCRONIZAÇÃO] transporte, APIs e estado operacional prontos; atendimento ainda protegido pela trava inicial `
      + `| ${readinessSummary({ ...readiness, state: operational.state, waitedMs: readiness.waitedMs + operational.waitedMs })}`,
    );

    scheduleStartupGateRelease(channel, startupGate);
    return channel;
  };

  const originalCollectUnreadMessages = WppClient.collectUnreadMessages.bind(WppClient);
  WppClient.collectUnreadMessages = async function collectUnreadMessagesWhenReady(client) {
    if (client?.__personalizeStartupGateClosed === true) {
      throw recoveryNotReadyError('WPP_STARTUP_GATE_CLOSED');
    }

    const timeoutMs = positiveNumber(
      process.env.WPP_RECOVERY_READY_TIMEOUT_MS,
      DEFAULT_RECOVERY_TIMEOUT_MS,
    );
    const readiness = await waitForSynchronization(client, { requireLabels: false, timeoutMs });
    if (!readiness.ready) {
      throw recoveryNotReadyError(readiness.reason || 'WPP_CORE_TIMEOUT', { readiness });
    }

    const operational = await waitForOperationalConnection({ client }, { timeoutMs });
    if (!operational.ready) {
      throw recoveryNotReadyError(operational.reason || 'WPP_CONNECTION_TIMEOUT', { operational });
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
  OPERATIONAL_STATES,
  createStartupMessageGate,
  inspectOperationalConnection,
  inspectSynchronization,
  installSynchronizationGuard,
  readinessSummary,
  recoveryNotReadyError,
  scheduleStartupGateRelease,
  waitForOperationalConnection,
  waitForSynchronization,
};
