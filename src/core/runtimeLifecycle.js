'use strict';

const Persistence = require('../services/persistence');
const StorageMaintenance = require('../services/storageMaintenance');
const TesterRuntime = require('./testerRuntime');
const { decision, decisionError } = require('./decisionLogger');

const OPERATIONAL_STATE_RE = /(CONNECTED|MAIN|NORMAL|INCHAT|IN_CHAT)/i;
const CLOSED_STATE_RE = /(DISCONNECTED|UNPAIRED|UNLAUNCHED|CONFLICT|TIMEOUT|CLOSED|LOGOUT)/i;

const state = {
  phase: 'starting',
  acceptingMessages: true,
  startedAt: new Date().toISOString(),
  readyAt: null,
  shutdownRequestedAt: null,
  stoppedAt: null,
  connectionState: 'STARTING',
  connectionUpdatedAt: new Date().toISOString(),
  lastIncomingAt: null,
  lastOutgoingAt: null,
  lastErrorAt: null,
  lastErrorCode: null,
  mockMode: false,
  channel: null,
  shutdownPromise: null,
  closers: new Map(),
};

function nowIso() {
  return new Date().toISOString();
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms || 0))));
}

function configuredNumber(name, fallback, minimum = 0) {
  const value = Number(process.env[name]);
  return Math.max(minimum, Number.isFinite(value) ? value : fallback);
}

function runtimeCollections() {
  return TesterRuntime?._test?.runtime || { buffers: new Set(), queues: new Set() };
}

function runtimeSnapshot() {
  const runtime = runtimeCollections();
  const snapshot = {
    buffers: 0,
    bufferedChats: 0,
    bufferedMessages: 0,
    bufferedBytes: 0,
    queues: 0,
    queuedTasks: 0,
    activeChats: 0,
    runningTasks: 0,
    timedOutTasks: 0,
  };

  for (const buffer of runtime.buffers || []) {
    snapshot.buffers += 1;
    try {
      const stats = buffer?.stats?.() || {};
      snapshot.bufferedChats += Number(stats.activeChats || 0);
      snapshot.bufferedMessages += Number(stats.messages || 0);
      snapshot.bufferedBytes += Number(stats.bytes || 0);
    } catch (_) {}
  }

  for (const queue of runtime.queues || []) {
    snapshot.queues += 1;
    try {
      const stats = queue?.stats?.() || {};
      snapshot.queuedTasks += Number(stats.queued || 0);
      snapshot.activeChats += Number(stats.activeChats || 0);
      snapshot.runningTasks += Number(stats.runningTasks || 0);
      snapshot.timedOutTasks += Number(stats.timedOutTasks || 0);
    } catch (_) {}
  }

  return snapshot;
}

function memorySnapshot() {
  const memory = process.memoryUsage();
  const mb = (value) => Math.round((Number(value || 0) / 1024 / 1024) * 10) / 10;
  return {
    rssMb: mb(memory.rss),
    heapUsedMb: mb(memory.heapUsed),
    heapTotalMb: mb(memory.heapTotal),
    externalMb: mb(memory.external),
    arrayBuffersMb: mb(memory.arrayBuffers),
  };
}

function safeStorageSnapshot() {
  try {
    const raw = StorageMaintenance.healthSnapshot({ forceIntegrityCheck: false }) || {};
    return {
      driver: raw.driver || Persistence.storageInfo().driver,
      encrypted: Boolean(raw.encrypted),
      sqlite: Boolean(raw.sqlite),
      databaseBytes: Number(raw.databaseBytes || 0),
      walBytes: Number(raw.walBytes || 0),
      documents: Number(raw.documents || 0),
      events: Number(raw.events || 0),
      integrity: raw.integrity || null,
      error: raw.error || null,
    };
  } catch (error) {
    return {
      driver: Persistence.storageInfo().driver,
      encrypted: Persistence.storageInfo().encrypted,
      sqlite: Persistence.storageInfo().driver === 'sqlite',
      databaseBytes: 0,
      walBytes: 0,
      documents: 0,
      events: 0,
      integrity: null,
      error: error?.message || String(error),
    };
  }
}

function registerChannel(channel, { mock = false } = {}) {
  state.channel = channel || null;
  state.mockMode = Boolean(mock);
  return state.channel;
}

function registerCloser(name, closer) {
  if (!name || typeof closer !== 'function') return false;
  state.closers.set(String(name), closer);
  return true;
}

function unregisterCloser(name) {
  return state.closers.delete(String(name || ''));
}

function markConnectionState(value) {
  const normalized = String(value || '').trim().toUpperCase() || 'UNKNOWN';
  state.connectionState = normalized;
  state.connectionUpdatedAt = nowIso();
  return normalized;
}

function markReady({ mock = state.mockMode } = {}) {
  state.mockMode = Boolean(mock);
  state.phase = 'ready';
  state.acceptingMessages = true;
  state.readyAt = state.readyAt || nowIso();
  if (state.mockMode) markConnectionState('MOCK');
  return snapshotState();
}

function markFailed(error) {
  state.phase = 'failed';
  state.acceptingMessages = false;
  state.lastErrorAt = nowIso();
  state.lastErrorCode = String(error?.code || error?.message || error || 'runtime_failed');
  return snapshotState();
}

function recordIncoming() {
  state.lastIncomingAt = nowIso();
}

function recordOutgoing() {
  state.lastOutgoingAt = nowIso();
}

function recordError(error) {
  state.lastErrorAt = nowIso();
  state.lastErrorCode = String(error?.code || error?.message || error || 'runtime_error');
}

function isAcceptingMessages() {
  return state.acceptingMessages && !['shutting_down', 'stopped', 'failed'].includes(state.phase);
}

function snapshotState() {
  return {
    phase: state.phase,
    acceptingMessages: isAcceptingMessages(),
    startedAt: state.startedAt,
    readyAt: state.readyAt,
    shutdownRequestedAt: state.shutdownRequestedAt,
    stoppedAt: state.stoppedAt,
    connectionState: state.connectionState,
    connectionUpdatedAt: state.connectionUpdatedAt,
    lastIncomingAt: state.lastIncomingAt,
    lastOutgoingAt: state.lastOutgoingAt,
    lastErrorAt: state.lastErrorAt,
    lastErrorCode: state.lastErrorCode,
    mockMode: state.mockMode,
  };
}

async function withTimeout(action, timeoutMs, code = 'OPERATION_TIMEOUT') {
  const safeTimeout = Math.max(50, Number(timeoutMs || 0));
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(action),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error(code);
          error.code = code;
          reject(error);
        }, safeTimeout);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function probeWhatsApp({ timeoutMs } = {}) {
  if (state.mockMode) return { ok: true, connected: true, apiReady: true, source: 'mock' };

  const client = state.channel?.client;
  if (!client) return { ok: false, connected: false, apiReady: false, reason: 'client_unavailable' };

  let connected = !CLOSED_STATE_RE.test(state.connectionState);
  if (typeof client.isConnected === 'function') {
    try {
      const result = await withTimeout(() => client.isConnected(), timeoutMs || 1500, 'WPP_CONNECTED_TIMEOUT');
      if (typeof result === 'boolean') connected = result;
    } catch (_) {}
  }

  let apiReady = false;
  if (client?.page?.evaluate) {
    try {
      apiReady = Boolean(await withTimeout(() => client.page.evaluate(() => Boolean(
        window.WPP?.chat
        && window.WPP?.labels
        && window.Store?.Chat,
      )), timeoutMs || 1500, 'WPP_API_TIMEOUT'));
    } catch (_) {
      apiReady = false;
    }
  } else {
    apiReady = Boolean(OPERATIONAL_STATE_RE.test(state.connectionState) && connected);
  }

  return {
    ok: Boolean(connected && apiReady),
    connected: Boolean(connected),
    apiReady: Boolean(apiReady),
    source: client?.page?.evaluate ? 'browser_probe' : 'connection_state',
  };
}

function liveSnapshot() {
  return {
    ok: state.phase !== 'stopped',
    phase: state.phase,
    uptimeSeconds: Math.max(0, Math.floor(process.uptime())),
    startedAt: state.startedAt,
  };
}

async function readinessSnapshot() {
  const whatsapp = await probeWhatsApp();
  const ready = state.phase === 'ready' && whatsapp.ok;
  return {
    ok: ready,
    ready,
    connected: whatsapp.connected,
    apiReady: whatsapp.apiReady,
    phase: state.phase,
    connectionState: state.connectionState,
    acceptingMessages: isAcceptingMessages(),
  };
}

async function healthSnapshot() {
  const readiness = await readinessSnapshot();
  const runtime = runtimeSnapshot();
  const memory = memorySnapshot();
  const storage = safeStorageSnapshot();
  const rssCriticalMb = configuredNumber('HEALTH_RSS_CRITICAL_MB', 900, 128);
  const queueCritical = configuredNumber('HEALTH_QUEUE_CRITICAL_SIZE', 35, 1);

  const checks = {
    readiness: readiness.ready,
    whatsapp: readiness.connected && readiness.apiReady,
    storage: !storage.error && storage.integrity?.ok !== false,
    memory: memory.rssMb < rssCriticalMb,
    queue: runtime.queuedTasks < queueCritical,
    timedOutTasks: runtime.timedOutTasks === 0,
  };
  const ok = Object.values(checks).every(Boolean);

  return {
    ok,
    ready: readiness.ready,
    connected: readiness.connected,
    apiReady: readiness.apiReady,
    phase: state.phase,
    acceptingMessages: isAcceptingMessages(),
    connectionState: state.connectionState,
    uptimeSeconds: Math.max(0, Math.floor(process.uptime())),
    timestamps: {
      startedAt: state.startedAt,
      readyAt: state.readyAt,
      connectionUpdatedAt: state.connectionUpdatedAt,
      lastIncomingAt: state.lastIncomingAt,
      lastOutgoingAt: state.lastOutgoingAt,
      lastErrorAt: state.lastErrorAt,
    },
    checks,
    runtime,
    memory,
    storage,
  };
}

function flushAllBuffers() {
  let flushedMessages = 0;
  for (const buffer of runtimeCollections().buffers || []) {
    const ids = [...(buffer?.map?.keys?.() || [])];
    for (const id of ids) {
      try {
        if (typeof buffer?._flush === 'function') flushedMessages += Number(buffer._flush(id, 'encerramento') || 0);
        else flushedMessages += Number(buffer?.clear?.(id) || 0);
      } catch (error) {
        recordError(error);
      }
    }
  }
  return flushedMessages;
}

function abortRemainingWork(code = 'SHUTDOWN_TIMEOUT') {
  let queuedCancelled = 0;
  let runningSignalled = 0;
  for (const queue of runtimeCollections().queues || []) {
    const queuedIds = [...new Set((queue?.queue || []).map((item) => item?.chatId).filter(Boolean))];
    const runningIds = [...new Set([...(queue?.runningItems?.values?.() || [])].map((item) => item?.chatId).filter(Boolean))];
    try { queuedCancelled += Number(queue?.cancelQueuedForChats?.(queuedIds, code) || 0); } catch (_) {}
    try { runningSignalled += Number(queue?.cancelRunningForChats?.(runningIds, code) || 0); } catch (_) {}
  }
  return { queuedCancelled, runningSignalled };
}

async function waitForRuntimeIdle({ deadline, stableMs = 350 } = {}) {
  let stableSince = null;
  while (Date.now() < deadline) {
    const runtime = runtimeSnapshot();
    const idle = runtime.bufferedChats === 0
      && runtime.bufferedMessages === 0
      && runtime.queuedTasks === 0
      && runtime.runningTasks === 0;

    if (idle) {
      stableSince = stableSince || Date.now();
      if ((Date.now() - stableSince) >= stableMs) return { idle: true, runtime };
    } else {
      stableSince = null;
    }
    await wait(50);
  }
  return { idle: false, runtime: runtimeSnapshot() };
}

async function closeWhatsApp(deadline) {
  const client = state.channel?.client;
  if (!client) return { closed: false, reason: 'client_unavailable' };

  const remaining = Math.max(100, deadline - Date.now());
  try {
    if (typeof client.close === 'function') {
      await withTimeout(() => client.close(), Math.min(remaining, 3000), 'WPP_CLOSE_TIMEOUT');
      return { closed: true, method: 'client.close' };
    }
    if (client?.page?.browser) {
      const browser = client.page.browser();
      if (typeof browser?.close === 'function') {
        await withTimeout(() => browser.close(), Math.min(remaining, 3000), 'BROWSER_CLOSE_TIMEOUT');
        return { closed: true, method: 'browser.close' };
      }
    }
    return { closed: false, reason: 'close_api_unavailable' };
  } catch (error) {
    recordError(error);
    return { closed: false, reason: error?.code || error?.message || String(error) };
  }
}

async function runClosers(deadline) {
  const results = [];
  for (const [name, closer] of state.closers.entries()) {
    const remaining = Math.max(100, deadline - Date.now());
    try {
      await withTimeout(() => closer(), Math.min(remaining, 2000), `CLOSER_TIMEOUT_${name}`);
      results.push({ name, ok: true });
    } catch (error) {
      recordError(error);
      results.push({ name, ok: false, error: error?.code || error?.message || String(error) });
    }
  }
  return results;
}

async function gracefulShutdown({ signal = 'manual', timeoutMs } = {}) {
  if (state.shutdownPromise) return state.shutdownPromise;

  state.shutdownPromise = (async () => {
    const safeTimeoutMs = configuredNumber(
      'GRACEFUL_SHUTDOWN_TIMEOUT_MS',
      Number(timeoutMs || 12000),
      1000,
    );
    const deadline = Date.now() + safeTimeoutMs;
    state.phase = 'shutting_down';
    state.acceptingMessages = false;
    state.shutdownRequestedAt = nowIso();

    decision('SISTEMA', 'encerramento_iniciado', {
      motivo: signal,
      espera: `${safeTimeoutMs}ms`,
      status: 'drenando',
    });

    const flushedMessages = flushAllBuffers();
    const idleResult = await waitForRuntimeIdle({ deadline });
    const forcedWork = idleResult.idle ? { queuedCancelled: 0, runningSignalled: 0 } : abortRemainingWork();

    if (!idleResult.idle) {
      decision('SISTEMA', 'encerramento_timeout', {
        motivo: signal,
        status: 'forçado',
        fila: idleResult.runtime.queuedTasks,
        chatsAtivos: idleResult.runtime.activeChats,
      }, 'warn');
    }

    if (global.__personalizeRuntimeOptimizationTimer) {
      clearInterval(global.__personalizeRuntimeOptimizationTimer);
      global.__personalizeRuntimeOptimizationTimer = null;
    }

    const whatsapp = await closeWhatsApp(deadline);
    const closers = await runClosers(deadline);
    try { Persistence.close(); } catch (error) { recordError(error); }

    state.phase = 'stopped';
    state.stoppedAt = nowIso();

    const result = {
      ok: idleResult.idle,
      forced: !idleResult.idle,
      signal,
      flushedMessages,
      runtime: idleResult.runtime,
      forcedWork,
      whatsapp,
      closers,
      stoppedAt: state.stoppedAt,
    };

    decision('SISTEMA', 'encerramento_concluído', {
      motivo: signal,
      status: result.forced ? 'forçado' : 'seguro',
      quantidade: flushedMessages,
      resultado: whatsapp.closed ? 'whatsapp_fechado' : 'whatsapp_sem_confirmação',
    }, result.forced ? 'warn' : 'log');

    return result;
  })().catch((error) => {
    recordError(error);
    decisionError('encerramento_falhou', error, { motivo: signal });
    try { Persistence.close(); } catch (_) {}
    state.phase = 'stopped';
    state.stoppedAt = nowIso();
    return { ok: false, forced: true, signal, error: error?.message || String(error) };
  });

  return state.shutdownPromise;
}

function resetForTests() {
  state.phase = 'starting';
  state.acceptingMessages = true;
  state.startedAt = nowIso();
  state.readyAt = null;
  state.shutdownRequestedAt = null;
  state.stoppedAt = null;
  state.connectionState = 'STARTING';
  state.connectionUpdatedAt = nowIso();
  state.lastIncomingAt = null;
  state.lastOutgoingAt = null;
  state.lastErrorAt = null;
  state.lastErrorCode = null;
  state.mockMode = false;
  state.channel = null;
  state.shutdownPromise = null;
  state.closers.clear();
}

module.exports = {
  gracefulShutdown,
  healthSnapshot,
  isAcceptingMessages,
  liveSnapshot,
  markConnectionState,
  markFailed,
  markReady,
  probeWhatsApp,
  readinessSnapshot,
  recordError,
  recordIncoming,
  recordOutgoing,
  registerChannel,
  registerCloser,
  runtimeSnapshot,
  snapshotState,
  unregisterCloser,
  _test: {
    abortRemainingWork,
    flushAllBuffers,
    resetForTests,
    state,
    waitForRuntimeIdle,
  },
};
