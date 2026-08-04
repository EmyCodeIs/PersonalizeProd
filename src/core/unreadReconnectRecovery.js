'use strict';

const CONNECTED_STATES = new Set(['CONNECTED']);
const DISCONNECTED_STATES = new Set([
  'CONFLICT',
  'UNPAIRED',
  'UNPAIRED_IDLE',
  'DISCONNECTED',
  'DISCONNECTEDMOBILE',
  'PHONENOTCONNECTED',
  'PHONE_NOT_CONNECTED',
]);

function normalizeConnectionState(value) {
  return String(value || '').trim().toUpperCase();
}

function isConnectedState(value) {
  return CONNECTED_STATES.has(normalizeConnectionState(value));
}

function isDisconnectedState(value) {
  return DISCONNECTED_STATES.has(normalizeConnectionState(value));
}

function createReconnectTracker(onReconnect) {
  let disconnected = false;

  return function trackConnectionState(state) {
    const normalized = normalizeConnectionState(state);

    if (isDisconnectedState(normalized)) {
      disconnected = true;
      return { normalized, disconnected: true, reconnected: false };
    }

    if (isConnectedState(normalized)) {
      const reconnected = disconnected;
      disconnected = false;
      if (reconnected && typeof onReconnect === 'function') onReconnect(normalized);
      return { normalized, disconnected: false, reconnected };
    }

    // SYNCING e RESUMING são transições, não confirmação de que a sessão
    // está pronta para recuperar e processar mensagens pendentes.
    return { normalized, disconnected, reconnected: false };
  };
}

function createRecoveryRunner({ collectUnreadMessages, onMessage, getClient, delayMs, logger = console }) {
  let timer = null;
  let running = false;
  let rerunRequested = false;
  let rerunSource = 'reconexao';

  function schedule(source = 'reconexao', customDelayMs = delayMs) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void run(source);
    }, Math.max(0, Number(customDelayMs || 0)));
    timer.unref?.();
    return timer;
  }

  async function run(source = 'reconexao') {
    if (running) {
      rerunRequested = true;
      rerunSource = source;
      return { skipped: true, reason: 'RUNNING' };
    }

    running = true;
    try {
      const client = getClient?.();
      if (!client) return { skipped: true, reason: 'CLIENT_UNAVAILABLE' };

      const unread = await collectUnreadMessages(client);
      logger.log(`[RECUPERAÇÃO][${source}] mensagens elegíveis=${unread.length}`);

      let delivered = 0;
      for (const item of unread) {
        await onMessage?.({
          from: item.from,
          text: item.text,
          raw: item.raw,
          source: `unread-${source}`,
        });
        delivered += 1;
      }

      logger.log(`[RECUPERAÇÃO][${source}] entregues à fila=${delivered}`);
      return { skipped: false, found: unread.length, delivered };
    } catch (error) {
      logger.warn(`[RECUPERAÇÃO][${source}] falhou:`, error?.message || error);
      return { skipped: false, error };
    } finally {
      running = false;
      if (rerunRequested) {
        const pendingSource = rerunSource;
        rerunRequested = false;
        rerunSource = 'reconexao';
        schedule(pendingSource, 1000);
      }
    }
  }

  function dispose() {
    if (timer) clearTimeout(timer);
    timer = null;
  }

  return {
    dispose,
    isRunning: () => running,
    run,
    schedule,
  };
}

module.exports = {
  CONNECTED_STATES,
  DISCONNECTED_STATES,
  createReconnectTracker,
  createRecoveryRunner,
  isConnectedState,
  isDisconnectedState,
  normalizeConnectionState,
};
