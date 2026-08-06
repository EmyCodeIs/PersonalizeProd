'use strict';

const { EventEmitter } = require('events');

const STATES = Object.freeze({
  STARTING: 'STARTING',
  WAITING_QR: 'WAITING_QR',
  AUTHENTICATING: 'AUTHENTICATING',
  SYNCING: 'SYNCING',
  READY: 'READY',
  DEGRADED: 'DEGRADED',
  DISCONNECTED: 'DISCONNECTED',
  RECOVERING: 'RECOVERING',
  FAILED: 'FAILED',
});

const READY_RAW_STATES = new Set(['CONNECTED', 'INCHAT']);
const SYNC_RAW_STATES = new Set(['SYNCING', 'RESUMING']);
const QR_RAW_STATES = new Set([
  'PAIRING',
  'QRCODE',
  'QR_CODE',
  'UNPAIRED',
  'UNPAIRED_IDLE',
  'NOTLOGGED',
  'NOT_LOGGED',
  'QRREADERROR',
  'QR_READ_ERROR',
  'QRREADFAIL',
  'QR_READ_FAIL',
]);
const AUTH_RAW_STATES = new Set([
  'OPENING',
  'INITIALIZING',
  'AUTHENTICATING',
  'QRREADSUCCESS',
  'QR_READ_SUCCESS',
  'ISLOGGED',
  'IS_LOGGED',
]);
const DISCONNECTED_RAW_STATES = new Set([
  'CONFLICT',
  'DISCONNECTED',
  'DISCONNECTEDMOBILE',
  'PHONE_NOT_CONNECTED',
  'PHONENOTCONNECTED',
  'BROWSER_CLOSE',
  'BROWSERCLOSE',
  'SERVER_CLOSE',
  'SERVERCLOSE',
  'AUTO_CLOSE_CALLED',
  'AUTOCLOSECALLED',
]);

let activeSupervisor = null;
const clientSupervisors = new WeakMap();

function nowIso() {
  return new Date().toISOString();
}

function normalizeRawState(value) {
  return String(value || '')
    .trim()
    .replace(/[\s-]+/g, '_')
    .toUpperCase();
}

function serializeError(error) {
  if (!error) return null;
  return {
    code: String(error.code || 'CONNECTION_ERROR'),
    message: String(error.message || error),
    at: nowIso(),
  };
}

function wait(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, Math.max(0, Number(ms || 0)));
    timer.unref?.();
  });
}

function withTimeout(promise, timeoutMs, code = 'CONNECTION_OPERATION_TIMEOUT') {
  const duration = Math.max(1, Number(timeoutMs || 1));
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error(`Operação da conexão excedeu ${duration}ms.`);
        error.code = code;
        reject(error);
      }, duration);
      timer.unref?.();
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

class ConnectionSupervisor extends EventEmitter {
  constructor({ config = {}, logger = console, exitProcess } = {}) {
    super();
    this.config = config;
    this.logger = logger;
    this.exitProcess = typeof exitProcess === 'function'
      ? exitProcess
      : (code) => process.exit(code);

    this.state = STATES.STARTING;
    this.rawState = '';
    this.rawSource = 'constructor';
    this.generation = 0;
    this.client = null;
    this.startedAt = nowIso();
    this.updatedAt = this.startedAt;
    this.lastStateAt = this.startedAt;
    this.lastReadyAt = null;
    this.lastInboundAt = null;
    this.lastOutboundAt = null;
    this.lastProbeAt = null;
    this.lastProbe = null;
    this.lastError = null;
    this.syncStartedAt = null;
    this.recoveryStartedAt = null;
    this.recoveryAttempts = 0;
    this.lastRecoveryAction = null;
    this.exitRequested = false;
    this.disposed = false;
    this.syncTimer = null;
    this.recoveryTimer = null;
    this.exitTimer = null;
    this.recoveryPromise = null;
  }

  beginGeneration(reason = 'create') {
    this.clearTimers();
    this.generation += 1;
    this.client = null;
    this.rawState = '';
    this.rawSource = reason;
    this.recoveryAttempts = 0;
    this.lastRecoveryAction = null;
    this.lastError = null;
    this.syncStartedAt = null;
    this.recoveryStartedAt = null;
    this.exitRequested = false;
    this.disposed = false;
    this.transition(STATES.STARTING, { reason, force: true });
    return this.generation;
  }

  clearTimers() {
    for (const key of ['syncTimer', 'recoveryTimer', 'exitTimer']) {
      if (this[key]) clearTimeout(this[key]);
      this[key] = null;
    }
  }

  transition(nextState, details = {}) {
    if (this.disposed) return false;
    const previousState = this.state;
    const changed = previousState !== nextState;
    this.state = nextState;
    this.updatedAt = nowIso();
    this.lastStateAt = this.updatedAt;

    if (details.error) this.lastError = serializeError(details.error);
    if (changed || details.force) {
      this.logger.log(
        `[CONEXÃO] ${previousState} -> ${nextState} | geração=${this.generation}`
        + `${details.reason ? ` | motivo=${details.reason}` : ''}`
        + `${this.rawState ? ` | raw=${this.rawState}` : ''}`,
      );
      this.emit('state', {
        previousState,
        state: nextState,
        generation: this.generation,
        reason: details.reason || null,
        rawState: this.rawState,
        at: this.updatedAt,
      });
    }
    return changed;
  }

  attachClient(client, generation = this.generation) {
    if (!client || this.disposed || generation !== this.generation) return false;
    if (this.client === client) return true;

    this.client = client;
    clientSupervisors.set(client, this);

    if (typeof client.onStateChange === 'function') {
      client.onStateChange((state) => {
        this.observeState(state, { source: 'onStateChange', generation });
      });
    }

    void this.probe('attach').catch((error) => {
      this.logger.warn('[CONEXÃO] probe inicial falhou:', error?.message || error);
    });
    return true;
  }

  observeState(value, { source = 'runtime', generation = this.generation } = {}) {
    if (this.disposed || generation !== this.generation) {
      return { ignored: true, reason: 'STALE_GENERATION' };
    }

    const normalized = normalizeRawState(value);
    if (!normalized) return { ignored: true, reason: 'EMPTY_STATE' };

    this.rawState = normalized;
    this.rawSource = source;
    this.updatedAt = nowIso();

    if (normalized === 'INCHAT') {
      this.markReady({ source, rawState: normalized });
      return { ignored: false, state: this.state };
    }

    if (normalized === 'CONNECTED') {
      if (!this.client) {
        this.transition(STATES.AUTHENTICATING, { reason: `${source}:${normalized}:awaiting_probe` });
      } else {
        void this.probe(`state_${source}`).catch((error) => {
          this.logger.warn('[CONEXÃO] confirmação de READY falhou:', error?.message || error);
        });
      }
      return { ignored: false, state: this.state };
    }

    if (SYNC_RAW_STATES.has(normalized)) {
      this.enterSyncing({ source, rawState: normalized });
      return { ignored: false, state: this.state };
    }

    if (QR_RAW_STATES.has(normalized)) {
      this.enterWaitingQr({ source, rawState: normalized });
      return { ignored: false, state: this.state };
    }

    if (DISCONNECTED_RAW_STATES.has(normalized)) {
      this.enterDisconnected({ source, rawState: normalized });
      return { ignored: false, state: this.state };
    }

    if (AUTH_RAW_STATES.has(normalized)) {
      if (this.state !== STATES.READY) {
        this.transition(STATES.AUTHENTICATING, { reason: `${source}:${normalized}` });
      }
      return { ignored: false, state: this.state };
    }

    return { ignored: true, reason: 'UNMAPPED_STATE', state: this.state };
  }

  markReady({ source = 'runtime', rawState = 'CONNECTED' } = {}) {
    const wasReady = this.state === STATES.READY;
    if (this.syncTimer) clearTimeout(this.syncTimer);
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    this.syncTimer = null;
    this.recoveryTimer = null;
    this.rawState = normalizeRawState(rawState) || 'CONNECTED';
    this.rawSource = source;
    this.syncStartedAt = null;
    this.recoveryStartedAt = null;
    this.recoveryAttempts = 0;
    this.lastRecoveryAction = null;
    this.lastError = null;
    this.lastReadyAt = nowIso();
    this.transition(STATES.READY, { reason: `${source}:${this.rawState}` });

    if (!wasReady) {
      this.emit('ready', {
        generation: this.generation,
        rawState: this.rawState,
        at: this.lastReadyAt,
      });
    }
  }

  enterSyncing({ source = 'runtime', rawState = 'SYNCING' } = {}) {
    this.rawState = normalizeRawState(rawState) || 'SYNCING';
    this.rawSource = source;
    if (!this.syncStartedAt) this.syncStartedAt = nowIso();
    this.transition(STATES.SYNCING, { reason: `${source}:${this.rawState}` });

    if (this.syncTimer) clearTimeout(this.syncTimer);
    const generation = this.generation;
    this.syncTimer = setTimeout(() => {
      this.syncTimer = null;
      if (this.disposed || generation !== this.generation || this.state !== STATES.SYNCING) return;
      const error = new Error(`WhatsApp permaneceu em sincronização por mais de ${this.config.syncTimeoutMs}ms.`);
      error.code = 'WPP_SYNC_TIMEOUT';
      this.lastError = serializeError(error);
      this.transition(STATES.DEGRADED, { reason: 'sync_timeout', error });
      void this.recover('sync_timeout');
    }, Math.max(1, Number(this.config.syncTimeoutMs || 195000)));
    this.syncTimer.unref?.();
  }

  enterWaitingQr({ source = 'runtime', rawState = 'PAIRING' } = {}) {
    if (this.syncTimer) clearTimeout(this.syncTimer);
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    this.syncTimer = null;
    this.recoveryTimer = null;
    this.rawState = normalizeRawState(rawState) || 'PAIRING';
    this.rawSource = source;
    this.syncStartedAt = null;
    this.recoveryStartedAt = null;
    this.recoveryAttempts = 0;
    this.transition(STATES.WAITING_QR, { reason: `${source}:${this.rawState}` });
  }

  enterDisconnected({ source = 'runtime', rawState = 'DISCONNECTED' } = {}) {
    if (this.syncTimer) clearTimeout(this.syncTimer);
    this.syncTimer = null;
    this.rawState = normalizeRawState(rawState) || 'DISCONNECTED';
    this.rawSource = source;
    this.syncStartedAt = null;
    this.transition(STATES.DISCONNECTED, { reason: `${source}:${this.rawState}` });
    this.scheduleRecovery(`state_${this.rawState.toLowerCase()}`);
  }

  scheduleRecovery(reason = 'disconnected', delayMs = this.config.recoveryDelayMs) {
    if (this.disposed || this.isReady() || this.state === STATES.WAITING_QR || this.recoveryTimer) return false;
    const generation = this.generation;
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = null;
      if (this.disposed || generation !== this.generation) return;
      void this.recover(reason);
    }, Math.max(0, Number(delayMs || 0)));
    this.recoveryTimer.unref?.();
    return true;
  }

  async callClientMethod(name, args = [], timeoutMs = this.config.probeTimeoutMs) {
    if (!this.client || typeof this.client[name] !== 'function') return { available: false, value: null };
    const value = await withTimeout(
      this.client[name](...args),
      timeoutMs,
      `CONNECTION_${String(name).toUpperCase()}_TIMEOUT`,
    );
    return { available: true, value };
  }

  async probe(source = 'runtime') {
    if (this.disposed || !this.client) return { available: false, ready: false };
    const generation = this.generation;
    const result = {
      available: true,
      ready: false,
      source,
      connectionState: null,
      isConnected: null,
      isMainReady: null,
      at: nowIso(),
    };

    try {
      const stateResult = await this.callClientMethod('getConnectionState');
      if (stateResult.available) result.connectionState = normalizeRawState(stateResult.value);
    } catch (error) {
      result.connectionStateError = serializeError(error);
    }

    for (const [method, key] of [['isConnected', 'isConnected'], ['isMainReady', 'isMainReady']]) {
      try {
        const methodResult = await this.callClientMethod(method);
        if (methodResult.available) result[key] = methodResult.value === true;
      } catch (error) {
        result[`${key}Error`] = serializeError(error);
      }
    }

    if (this.disposed || generation !== this.generation) return { ...result, stale: true };
    this.lastProbeAt = result.at;
    this.lastProbe = result;

    if (READY_RAW_STATES.has(result.connectionState)) {
      const readinessChecksKnown = result.isConnected !== null || result.isMainReady !== null;
      const readinessDenied = result.isConnected === false || result.isMainReady === false;
      const readinessConfirmed = result.connectionState === 'INCHAT'
        || result.isMainReady === true
        || result.isConnected === true
        || !readinessChecksKnown;

      if (!readinessDenied && readinessConfirmed) {
        result.ready = true;
        this.markReady({ source: `probe:${source}`, rawState: result.connectionState });
      } else {
        this.enterSyncing({ source: `probe:${source}`, rawState: 'SYNCING' });
      }
    } else if (result.connectionState) {
      this.observeState(result.connectionState, { source: `probe:${source}`, generation });
    }

    return result;
  }

  async runRecoveryAction(attempt) {
    const rawState = normalizeRawState(this.rawState);

    if (attempt === 1) {
      if (rawState === 'CONFLICT' && typeof this.client?.useHere === 'function') {
        this.lastRecoveryAction = 'useHere';
        return withTimeout(
          this.client.useHere(),
          this.config.recoveryActionTimeoutMs,
          'CONNECTION_USE_HERE_TIMEOUT',
        );
      }
      if (typeof this.client?.startPhoneWatchdog === 'function') {
        this.lastRecoveryAction = 'startPhoneWatchdog';
        return withTimeout(
          this.client.startPhoneWatchdog(),
          this.config.recoveryActionTimeoutMs,
          'CONNECTION_WATCHDOG_TIMEOUT',
        );
      }
      this.lastRecoveryAction = 'probe_only';
      return false;
    }

    if (attempt === 2) {
      const page = this.client?.page || this.client?.waPage;
      if (typeof page?.reload === 'function') {
        this.lastRecoveryAction = 'page.reload';
        return withTimeout(
          page.reload({ waitUntil: 'domcontentloaded', timeout: this.config.recoveryActionTimeoutMs }),
          this.config.recoveryActionTimeoutMs + 1000,
          'CONNECTION_PAGE_RELOAD_TIMEOUT',
        );
      }
      this.lastRecoveryAction = 'reload_unavailable';
      return false;
    }

    this.lastRecoveryAction = 'controlled_process_restart';
    return false;
  }

  async recover(reason = 'runtime') {
    if (this.disposed || this.isReady() || this.state === STATES.WAITING_QR) {
      return { skipped: true, reason: this.state };
    }
    if (this.recoveryPromise) return this.recoveryPromise;

    const generation = this.generation;
    this.recoveryPromise = (async () => {
      this.recoveryAttempts += 1;
      const attempt = this.recoveryAttempts;
      this.recoveryStartedAt = nowIso();
      this.transition(STATES.RECOVERING, { reason: `${reason}:attempt_${attempt}` });

      const before = await this.probe(`before_recovery_${attempt}`);
      if (before.ready || this.isReady()) return { recovered: true, attempt, method: 'probe' };
      if (this.state === STATES.WAITING_QR) return { skipped: true, reason: STATES.WAITING_QR };

      if (attempt >= Number(this.config.maxRecoveryAttempts || 3)) {
        return this.failAndMaybeExit(reason, attempt);
      }

      try {
        await this.runRecoveryAction(attempt);
      } catch (error) {
        this.lastError = serializeError(error);
        this.logger.warn(
          `[CONEXÃO] ação de recuperação falhou | tentativa=${attempt} | ação=${this.lastRecoveryAction}:`,
          error?.message || error,
        );
      }

      await wait(this.config.recoveryDelayMs);
      if (this.disposed || generation !== this.generation) return { skipped: true, reason: 'STALE_GENERATION' };

      const after = await this.probe(`after_recovery_${attempt}`);
      if (after.ready || this.isReady()) {
        return { recovered: true, attempt, method: this.lastRecoveryAction };
      }
      if (this.state === STATES.WAITING_QR) return { skipped: true, reason: STATES.WAITING_QR };

      if (attempt + 1 >= Number(this.config.maxRecoveryAttempts || 3)) {
        return this.failAndMaybeExit(reason, attempt + 1);
      }

      this.transition(STATES.DEGRADED, { reason: `${reason}:recovery_incomplete` });
      this.scheduleRecovery(reason, this.config.recoveryCooldownMs);
      return { recovered: false, attempt, method: this.lastRecoveryAction };
    })().finally(() => {
      this.recoveryPromise = null;
    });

    return this.recoveryPromise;
  }

  failAndMaybeExit(reason, attempt) {
    const error = new Error(`Conexão não recuperada após ${attempt} tentativa(s).`);
    error.code = 'CONNECTION_RECOVERY_EXHAUSTED';
    this.lastError = serializeError(error);
    this.recoveryAttempts = Math.max(this.recoveryAttempts, attempt);
    this.transition(STATES.FAILED, { reason, error });

    if (!this.config.exitOnFailure || this.exitRequested || this.state === STATES.WAITING_QR) {
      return { recovered: false, failed: true, exitRequested: false, attempt };
    }

    this.exitRequested = true;
    const generation = this.generation;
    this.logger.error(
      `[CONEXÃO] reinício controlado solicitado | geração=${generation} `
      + `| atraso=${this.config.exitDelayMs}ms | tokens=preservados`,
    );
    this.emit('exit-requested', { generation, reason, attempt, at: nowIso() });
    this.exitTimer = setTimeout(() => {
      if (this.disposed || generation !== this.generation) return;
      this.exitProcess(1);
    }, Math.max(1, Number(this.config.exitDelayMs || 2500)));
    this.exitTimer.unref?.();

    return { recovered: false, failed: true, exitRequested: true, attempt };
  }

  reportFatal(error, reason = 'create_failed') {
    this.lastError = serializeError(error);
    this.transition(STATES.FAILED, { reason, error });
  }

  markInbound() {
    this.lastInboundAt = nowIso();
    this.updatedAt = this.lastInboundAt;
  }

  markOutbound() {
    this.lastOutboundAt = nowIso();
    this.updatedAt = this.lastOutboundAt;
  }

  isReady() {
    return !this.disposed && this.state === STATES.READY;
  }

  waitUntilReady({ timeoutMs = 0 } = {}) {
    if (this.isReady()) return Promise.resolve(this.snapshot());

    return new Promise((resolve, reject) => {
      let timer = null;
      const onReady = () => {
        cleanup();
        resolve(this.snapshot());
      };
      const cleanup = () => {
        this.removeListener('ready', onReady);
        if (timer) clearTimeout(timer);
      };

      this.on('ready', onReady);
      if (Number(timeoutMs) > 0) {
        timer = setTimeout(() => {
          cleanup();
          const error = new Error(`Conexão não ficou READY em ${timeoutMs}ms.`);
          error.code = 'CONNECTION_READY_TIMEOUT';
          reject(error);
        }, Number(timeoutMs));
        timer.unref?.();
      }
    });
  }

  snapshot() {
    return {
      state: this.state,
      ready: this.isReady(),
      generation: this.generation,
      rawState: this.rawState,
      rawSource: this.rawSource,
      startedAt: this.startedAt,
      updatedAt: this.updatedAt,
      lastStateAt: this.lastStateAt,
      lastReadyAt: this.lastReadyAt,
      lastInboundAt: this.lastInboundAt,
      lastOutboundAt: this.lastOutboundAt,
      lastProbeAt: this.lastProbeAt,
      lastProbe: this.lastProbe,
      lastError: this.lastError,
      syncStartedAt: this.syncStartedAt,
      recoveryStartedAt: this.recoveryStartedAt,
      recoveryAttempts: this.recoveryAttempts,
      lastRecoveryAction: this.lastRecoveryAction,
      exitRequested: this.exitRequested,
      clientAttached: Boolean(this.client),
      browserPageAttached: Boolean(this.client?.page || this.client?.waPage),
      processUptimeSeconds: Math.floor(process.uptime()),
    };
  }

  dispose() {
    this.disposed = true;
    this.clearTimers();
    this.removeAllListeners();
    this.client = null;
  }
}

function setActiveConnectionSupervisor(supervisor) {
  if (activeSupervisor && activeSupervisor !== supervisor) activeSupervisor.dispose();
  activeSupervisor = supervisor || null;
  return activeSupervisor;
}

function getActiveConnectionSupervisor() {
  return activeSupervisor;
}

function getClientConnectionSupervisor(client) {
  return client && clientSupervisors.get(client) || null;
}

function isClientReady(client) {
  const supervisor = getClientConnectionSupervisor(client) || activeSupervisor;
  if (supervisor) return supervisor.isReady();
  const enabled = !['0', 'false', 'no', 'nao', 'não', 'off'].includes(
    String(process.env.CONNECTION_SUPERVISOR_ENABLED ?? 'true').trim().toLowerCase(),
  );
  return !enabled;
}

module.exports = {
  AUTH_RAW_STATES,
  ConnectionSupervisor,
  DISCONNECTED_RAW_STATES,
  QR_RAW_STATES,
  READY_RAW_STATES,
  STATES,
  SYNC_RAW_STATES,
  getActiveConnectionSupervisor,
  getClientConnectionSupervisor,
  isClientReady,
  normalizeRawState,
  setActiveConnectionSupervisor,
  withTimeout,
};
