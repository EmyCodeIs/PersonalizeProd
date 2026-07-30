'use strict';

const Store = require('../services/leadStore');
const StorageMaintenance = require('../services/storageMaintenance');
const TesterRuntime = require('./testerRuntime');
const { env } = require('../config/env');
const { decision, decisionError } = require('./decisionLogger');

function entryTimestamp(entry) {
  for (const candidate of [entry?.at, entry?.checkedAt, entry?.updatedAt, entry?.createdAt]) {
    const value = typeof candidate === 'number' ? candidate : new Date(candidate || 0).getTime();
    if (Number.isFinite(value) && value > 0) return value;
  }
  return 0;
}

function pruneMap(map, { ttlMs, maxEntries } = {}) {
  if (!(map instanceof Map)) return { before: 0, after: 0, removed: 0 };

  const before = map.size;
  const now = Date.now();
  const safeTtlMs = Math.max(1000, Number(ttlMs || 0));
  const safeMaxEntries = Math.max(10, Number(maxEntries || env.runtimeCacheMaxEntries || 5000));

  for (const [key, entry] of map.entries()) {
    const timestamp = entryTimestamp(entry);
    if (timestamp && (now - timestamp) > safeTtlMs) map.delete(key);
  }

  if (map.size > safeMaxEntries) {
    const ordered = [...map.entries()].sort(([, left], [, right]) => (
      entryTimestamp(left) - entryTimestamp(right)
    ));
    const excess = map.size - safeMaxEntries;
    for (let index = 0; index < excess; index += 1) map.delete(ordered[index][0]);
  }

  return { before, after: map.size, removed: before - map.size };
}

function runtimeCollections() {
  return TesterRuntime?._test?.runtime || { buffers: new Set(), queues: new Set() };
}

function inspectRuntimeCollections() {
  const runtime = runtimeCollections();
  const result = {
    buffers: 0,
    bufferedChats: 0,
    bufferedMessages: 0,
    bufferedBytes: 0,
    staleBuffersFlushed: 0,
    queues: 0,
    queuedTasks: 0,
    activeChats: 0,
    timedOutTasks: 0,
  };

  for (const buffer of runtime.buffers || []) {
    result.buffers += 1;
    try { result.staleBuffersFlushed += Number(buffer?.sweep?.() || 0); } catch (_) {}
    try {
      const stats = buffer?.stats?.() || {};
      result.bufferedChats += Number(stats.activeChats || 0);
      result.bufferedMessages += Number(stats.messages || 0);
      result.bufferedBytes += Number(stats.bytes || 0);
    } catch (_) {}
  }

  for (const queue of runtime.queues || []) {
    result.queues += 1;
    try {
      const stats = queue?.stats?.() || {};
      result.queuedTasks += Number(stats.queued || 0);
      result.activeChats += Number(stats.activeChats || 0);
      result.timedOutTasks += Number(stats.timedOutTasks || 0);
    } catch (_) {}
  }

  return result;
}

function pruneHandoffCaches() {
  try {
    const HandoffSafety = require('./handoffSafetyPreload');
    const caches = HandoffSafety?._test || {};
    const maxEntries = Math.max(100, Number(env.runtimeCacheMaxEntries || 5000));
    const labels = pruneMap(caches.labelInspectionCache, {
      ttlMs: 60000,
      maxEntries,
    });
    const history = pruneMap(caches.historyInspectionCache, {
      ttlMs: 5 * 60 * 1000,
      maxEntries,
    });
    return { labels, history };
  } catch (error) {
    return { error: error?.message || String(error) };
  }
}

function memorySnapshot() {
  const memory = process.memoryUsage();
  const toMb = (value) => Math.round((Number(value || 0) / 1024 / 1024) * 10) / 10;
  return {
    rssMb: toMb(memory.rss),
    heapUsedMb: toMb(memory.heapUsed),
    heapTotalMb: toMb(memory.heapTotal),
    externalMb: toMb(memory.external),
    arrayBuffersMb: toMb(memory.arrayBuffers),
  };
}

function runRuntimeMaintenance({ reason = 'periodic', forceIntegrityCheck = false } = {}) {
  try {
    const sessionsPurged = Store.purgeExpiredSessions({ write: true }) === true;
    const caches = pruneHandoffCaches();
    const runtime = inspectRuntimeCollections();
    const database = StorageMaintenance.runStorageMaintenance({ reason, forceIntegrityCheck });
    const memory = memorySnapshot();

    decision('SISTEMA', 'manutenção_de_runtime', {
      motivo: reason,
      status: 'ok',
      sessõesExpiradas: sessionsPurged ? 'removidas' : 'nenhuma',
      cacheEtiquetasRemovido: caches.labels?.removed || 0,
      cacheHistóricoRemovido: caches.history?.removed || 0,
      buffers: runtime.bufferedChats,
      mensagensBuffer: runtime.bufferedMessages,
      fila: runtime.queuedTasks,
      chatsAtivos: runtime.activeChats,
      rssMb: memory.rssMb,
      heapMb: memory.heapUsedMb,
    });

    return { sessionsPurged, caches, runtime, database, memory };
  } catch (error) {
    decisionError('manutenção_de_runtime_falhou', error, { motivo: reason });
    console.error('[MANUTENÇÃO] falha isolada; atendimento continua:', error?.stack || error?.message || error);
    return { error: error?.message || String(error) };
  }
}

function startRuntimeOptimization() {
  if (global.__personalizeRuntimeOptimizationTimer) return global.__personalizeRuntimeOptimizationTimer;

  const firstRun = setImmediate(() => {
    runRuntimeMaintenance({ reason: 'startup', forceIntegrityCheck: true });
  });
  if (typeof firstRun.unref === 'function') firstRun.unref();

  const intervalMs = Math.max(60000, Number(env.maintenanceIntervalMs || 900000));
  const timer = setInterval(() => runRuntimeMaintenance({ reason: 'periodic' }), intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  global.__personalizeRuntimeOptimizationTimer = timer;
  return timer;
}

startRuntimeOptimization();

module.exports = {
  inspectRuntimeCollections,
  memorySnapshot,
  pruneHandoffCaches,
  pruneMap,
  runRuntimeMaintenance,
  startRuntimeOptimization,
  _test: { entryTimestamp, runtimeCollections },
};