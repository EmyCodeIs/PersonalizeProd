'use strict';

const CONNECTED_STATES = new Set(['CONNECTED', 'SYNCING', 'RESUMING']);
const DISCONNECTED_STATES = new Set([
  'CONFLICT',
  'UNPAIRED',
  'UNPAIRED_IDLE',
  'DISCONNECTED',
  'DISCONNECTEDMOBILE',
  'PHONENOTCONNECTED',
  'PHONE_NOT_CONNECTED',
]);
const RETRYABLE_RECOVERY_CODES = new Set([
  'WPP_RECOVERY_NOT_READY',
  'WPP_STARTUP_GATE_CLOSED',
  'WPP_SYNC_TIMEOUT',
  'WPP_CONNECTION_TIMEOUT',
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

function isRetryableRecoveryError(error) {
  return RETRYABLE_RECOVERY_CODES.has(String(error?.code || '').trim().toUpperCase());
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

    return { normalized, disconnected, reconnected: false };
  };
}

function createRecoveryRunner({
  collectUnreadMessages,
  onMessage,
  getClient,
  delayMs,
  retryDelayMs = delayMs,
  logger = console,
}) {
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
      if (isRetryableRecoveryError(error)) {
        const retryIn = Math.max(1, Number(retryDelayMs || delayMs || 1000));
        logger.warn(
          `[RECUPERAÇÃO][${source}] WhatsApp ainda não está pronto; nova tentativa em ${retryIn}ms `
          + `| motivo=${error.code}`,
        );
        schedule(source, retryIn);
        return {
          skipped: true,
          reason: error.code,
          retryScheduled: true,
          retryIn,
        };
      }

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
  RETRYABLE_RECOVERY_CODES,
  createReconnectTracker,
  createRecoveryRunner,
  isConnectedState,
  isDisconnectedState,
  isRetryableRecoveryError,
  normalizeConnectionState,
};
