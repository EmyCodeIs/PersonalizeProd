'use strict';

const fs = require('fs');
const Persistence = require('./persistence');
const { decision, decisionError } = require('../core/decisionLogger');

let lastIntegrityCheckAt = 0;

function boolEnv(name, fallback = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === '') return fallback;
  return ['1', 'true', 'yes', 'sim', 'on'].includes(String(raw).trim().toLowerCase());
}

function numEnv(name, fallback, minimum = 0) {
  const value = Number(process.env[name]);
  return Math.max(minimum, Number.isFinite(value) ? value : fallback);
}

function listEnv(name, fallback = []) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  return String(raw).split(/[;,\n]/).map((item) => item.trim()).filter(Boolean);
}

function fileSize(filePath) {
  try { return fs.statSync(filePath).size; } catch (_) { return 0; }
}

function pragmaScalar(db, name) {
  try {
    const row = db.prepare(`PRAGMA ${name}`).get();
    if (!row) return null;
    const value = Object.values(row)[0];
    return Number.isFinite(Number(value)) ? Number(value) : value;
  } catch (_) {
    return null;
  }
}

function tableCount(db, table) {
  try {
    return Number(db.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get()?.total || 0);
  } catch (_) {
    return 0;
  }
}

function streamStats(db) {
  try {
    return db.prepare(`
      SELECT stream_key AS stream, COUNT(*) AS total,
             MIN(created_at) AS oldest_at, MAX(created_at) AS newest_at
      FROM secure_events
      GROUP BY stream_key
      ORDER BY total DESC
    `).all().map((row) => ({
      stream: String(row.stream || ''),
      total: Number(row.total || 0),
      oldestAt: row.oldest_at || null,
      newestAt: row.newest_at || null,
    }));
  } catch (_) {
    return [];
  }
}

function runIntegrityCheck(db, { force = false } = {}) {
  const intervalMs = numEnv('STORAGE_QUICK_CHECK_INTERVAL_HOURS', 6, 1) * 60 * 60 * 1000;
  if (!force && (Date.now() - lastIntegrityCheckAt) < intervalMs) return null;
  lastIntegrityCheckAt = Date.now();

  try {
    const rows = db.prepare('PRAGMA quick_check').all();
    const messages = rows.map((row) => String(Object.values(row)[0] || '')).filter(Boolean);
    return {
      ok: messages.length === 1 && messages[0].toLowerCase() === 'ok',
      messages,
    };
  } catch (error) {
    return { ok: false, messages: [error?.message || String(error)] };
  }
}

function pruneTechnicalEvents(db) {
  if (!boolEnv('STORAGE_EVENT_PRUNE_ENABLED', false)) return { enabled: false, removed: 0 };

  const maxPerStream = numEnv('STORAGE_EVENT_MAX_PER_STREAM', 100000, 1000);
  const protectedStreams = new Set(listEnv('STORAGE_EVENT_PROTECTED_STREAMS', ['leads.jsonl']));
  let removed = 0;

  for (const stream of streamStats(db)) {
    if (!stream.stream || protectedStreams.has(stream.stream) || stream.total <= maxPerStream) continue;
    const excess = stream.total - maxPerStream;
    const result = db.prepare(`
      DELETE FROM secure_events
      WHERE id IN (
        SELECT id FROM secure_events
        WHERE stream_key = ?
        ORDER BY id ASC
        LIMIT ?
      )
    `).run(stream.stream, excess);
    removed += Number(result?.changes || 0);
  }

  return { enabled: true, removed, maxPerStream, protectedStreams: [...protectedStreams] };
}

function healthSnapshot({ forceIntegrityCheck = false } = {}) {
  const info = Persistence.storageInfo();
  if (info.driver !== 'sqlite') {
    return { driver: info.driver, encrypted: info.encrypted, sqlite: false };
  }

  const db = Persistence.getDatabase();
  const pageCount = Number(pragmaScalar(db, 'page_count') || 0);
  const freePages = Number(pragmaScalar(db, 'freelist_count') || 0);
  const pageSize = Number(pragmaScalar(db, 'page_size') || 0);
  const databaseBytes = fileSize(info.databasePath);
  const walBytes = fileSize(`${info.databasePath}-wal`);
  const shmBytes = fileSize(`${info.databasePath}-shm`);

  return {
    driver: info.driver,
    encrypted: info.encrypted,
    sqlite: true,
    databasePath: info.databasePath,
    databaseBytes,
    walBytes,
    shmBytes,
    pageCount,
    freePages,
    pageSize,
    freeRatio: pageCount > 0 ? freePages / pageCount : 0,
    documents: tableCount(db, 'secure_documents'),
    events: tableCount(db, 'secure_events'),
    metadata: tableCount(db, 'storage_metadata'),
    streams: streamStats(db),
    integrity: runIntegrityCheck(db, { force: forceIntegrityCheck }),
  };
}

function runStorageMaintenance({ reason = 'periodic', forceIntegrityCheck = false } = {}) {
  const info = Persistence.storageInfo();
  if (info.driver !== 'sqlite') return { driver: info.driver, skipped: true };

  try {
    const db = Persistence.getDatabase();
    try { db.exec('PRAGMA optimize'); } catch (_) {}

    let checkpoint = [];
    try { checkpoint = db.prepare('PRAGMA wal_checkpoint(PASSIVE)').all(); } catch (_) {}

    const pruning = pruneTechnicalEvents(db);
    const health = healthSnapshot({ forceIntegrityCheck });
    const warningThreshold = numEnv('STORAGE_EVENT_WARN_COUNT', 25000, 1000);

    if (health.events >= warningThreshold) {
      console.warn(
        `[BANCO] volume de eventos elevado | total=${health.events} | limiteAviso=${warningThreshold} `
        + '| dados comerciais protegidos; revisar retenção antes de excluir',
      );
    }
    if (health.integrity && !health.integrity.ok) {
      console.error(`[BANCO] quick_check falhou: ${health.integrity.messages.join(' | ')}`);
    }

    decision('SISTEMA', 'manutenção_do_banco', {
      motivo: reason,
      status: health.integrity?.ok === false ? 'atenção' : 'ok',
      documentos: health.documents,
      eventos: health.events,
      bancoMb: Math.round((health.databaseBytes / 1024 / 1024) * 100) / 100,
      walMb: Math.round((health.walBytes / 1024 / 1024) * 100) / 100,
      removidos: pruning.removed || 0,
    }, health.integrity?.ok === false ? 'error' : 'log');

    return { ...health, checkpoint, pruning };
  } catch (error) {
    decisionError('manutenção_do_banco_falhou', error, { motivo: reason });
    console.error('[BANCO] manutenção segura falhou; atendimento continua:', error?.stack || error?.message || error);
    return { driver: info.driver, error: error?.message || String(error) };
  }
}

module.exports = {
  healthSnapshot,
  pruneTechnicalEvents,
  runIntegrityCheck,
  runStorageMaintenance,
  _test: {
    boolEnv,
    fileSize,
    listEnv,
    numEnv,
    streamStats,
  },
};