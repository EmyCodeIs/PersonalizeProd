'use strict';

const crypto = require('crypto');
const path = require('path');
const Identity = require('./contactIdentity');
const Persistence = require('./persistence');
const { leadOperationsConfig } = require('../config/leadOperationsConfig');

const FILE_PATH = path.resolve(process.cwd(), 'data', 'outbound-ledger.json');
const SQLITE_TABLE = 'secure_outbound_messages';

const STATUS = Object.freeze({
  PENDING: 'PENDING',
  SENT: 'SENT',
  FAILED_RETRYABLE: 'FAILED_RETRYABLE',
  FAILED_FINAL: 'FAILED_FINAL',
  UNCERTAIN: 'UNCERTAIN',
});

const TERMINAL = new Set([STATUS.SENT, STATUS.FAILED_FINAL, STATUS.UNCERTAIN]);
const state = { loaded: false, records: {} };

function nowIso(now = Date.now()) {
  return new Date(Number(now) || Date.now()).toISOString();
}

function timestamp(value) {
  const parsed = new Date(value || 0).getTime();
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function clean(value, maxLength = 12000) {
  const text = String(value ?? '').trim();
  return text ? text.slice(0, maxLength) : '';
}

function normalizeConversation(value) {
  try { return Identity.normalizeChatId(value); } catch (_) {
    const raw = clean(value, 240).toLowerCase();
    if (!raw) return '';
    const digits = raw.replace(/\D/g, '');
    return digits ? `${digits}@c.us` : raw;
  }
}

function conversationKey(value) {
  try { return Identity.getSessionKey(value); } catch (_) {
    const normalized = normalizeConversation(value);
    return normalized ? `wa:${normalized}` : '';
  }
}

function storageIsSqlite() {
  return Persistence.storageInfo().driver === 'sqlite';
}

function ensureSqlite() {
  if (!storageIsSqlite()) return null;
  const db = Persistence.getDatabase();
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${SQLITE_TABLE} (
      ledger_id TEXT PRIMARY KEY,
      operation_key TEXT UNIQUE,
      conversation_key TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      sent_at TEXT,
      encrypted_payload TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_outbound_conversation
      ON ${SQLITE_TABLE}(conversation_key, created_at);

    CREATE INDEX IF NOT EXISTS idx_outbound_status_updated
      ON ${SQLITE_TABLE}(status, updated_at);
  `);
  return db;
}

function ensureFileState() {
  if (storageIsSqlite() || state.loaded) return;
  const parsed = Persistence.readJson(FILE_PATH, { version: 1, records: {} });
  state.records = parsed?.records && typeof parsed.records === 'object' ? parsed.records : {};
  state.loaded = true;
}

function persistFileState() {
  if (storageIsSqlite()) return;
  ensureFileState();
  Persistence.writeJson(FILE_PATH, {
    version: 1,
    updatedAt: nowIso(),
    records: state.records,
  });
}

function serialize(record) {
  return Persistence.encryptText(JSON.stringify(record));
}

function deserialize(value) {
  return JSON.parse(Persistence.decryptText(value));
}

function writeRecord(record) {
  if (!record?.id) return null;
  const next = { ...record, updatedAt: record.updatedAt || nowIso() };

  if (!storageIsSqlite()) {
    ensureFileState();
    state.records[next.id] = next;
    persistFileState();
    return { ...next };
  }

  ensureSqlite().prepare(`
    INSERT INTO ${SQLITE_TABLE}(
      ledger_id, operation_key, conversation_key, status,
      created_at, updated_at, sent_at, encrypted_payload
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(ledger_id) DO UPDATE SET
      operation_key = excluded.operation_key,
      conversation_key = excluded.conversation_key,
      status = excluded.status,
      created_at = excluded.created_at,
      updated_at = excluded.updated_at,
      sent_at = excluded.sent_at,
      encrypted_payload = excluded.encrypted_payload
  `).run(
    next.id,
    next.operationKey || null,
    next.conversationKey || '-',
    next.status,
    next.createdAt,
    next.updatedAt,
    next.sentAt || null,
    serialize(next),
  );
  return { ...next };
}

function readRecord(id) {
  const key = clean(id, 260);
  if (!key) return null;
  if (!storageIsSqlite()) {
    ensureFileState();
    return state.records[key] ? { ...state.records[key] } : null;
  }
  const row = ensureSqlite().prepare(
    `SELECT encrypted_payload FROM ${SQLITE_TABLE} WHERE ledger_id = ?`,
  ).get(key);
  return row?.encrypted_payload ? deserialize(row.encrypted_payload) : null;
}

function readByOperationKey(operationKey) {
  const key = clean(operationKey, 500);
  if (!key) return null;
  if (!storageIsSqlite()) {
    ensureFileState();
    return Object.values(state.records).find((record) => record.operationKey === key) || null;
  }
  const row = ensureSqlite().prepare(
    `SELECT encrypted_payload FROM ${SQLITE_TABLE} WHERE operation_key = ?`,
  ).get(key);
  return row?.encrypted_payload ? deserialize(row.encrypted_payload) : null;
}

function listAll() {
  if (!storageIsSqlite()) {
    ensureFileState();
    return Object.values(state.records).map((record) => ({ ...record }));
  }
  return ensureSqlite().prepare(
    `SELECT encrypted_payload FROM ${SQLITE_TABLE} ORDER BY created_at ASC`,
  ).all().map((row) => deserialize(row.encrypted_payload));
}

function deleteRecord(id) {
  const key = clean(id, 260);
  if (!key) return false;
  if (!storageIsSqlite()) {
    ensureFileState();
    if (!state.records[key]) return false;
    delete state.records[key];
    persistFileState();
    return true;
  }
  return Number(ensureSqlite().prepare(
    `DELETE FROM ${SQLITE_TABLE} WHERE ledger_id = ?`,
  ).run(key)?.changes || 0) > 0;
}

function appendHistory(record, status, reason = null, at = nowIso()) {
  const history = Array.isArray(record.history) ? [...record.history] : [];
  history.push({ status, reason: clean(reason, 600) || null, at });
  return history.slice(-30);
}

function extractMessageId(result = {}) {
  return clean(
    result?.id?._serialized
    || result?.id
    || result?.messageId
    || result?.key?.id
    || '',
    300,
  ) || null;
}

function safeResult(result) {
  if (result === true || result === false || result === null || result === undefined) {
    return { ok: result !== false && result !== null };
  }
  return {
    ok: true,
    messageId: extractMessageId(result),
    type: clean(result?.type, 80) || null,
    timestamp: Number(result?.timestamp || result?.t || 0) || null,
  };
}

function errorSummary(error) {
  const code = clean(error?.code, 120);
  const message = clean(error?.message || error || 'UNKNOWN_ERROR', 800);
  return [code, message].filter(Boolean).join(': ') || 'UNKNOWN_ERROR';
}

function createId(payload = {}) {
  const operationKey = clean(payload.operationKey, 500);
  if (operationKey) {
    return `out:${crypto.createHash('sha256').update(operationKey).digest('hex')}`;
  }
  return `out:${Date.now()}:${crypto.randomBytes(8).toString('hex')}`;
}

function begin(payload = {}) {
  const now = Number(payload.now || Date.now());
  const at = nowIso(now);
  const operationKey = clean(payload.operationKey, 500) || null;
  const uncertainAfterMs = Math.max(
    30000,
    Number(payload.uncertainAfterMs || leadOperationsConfig.outboundUncertainAfterMs),
  );
  const maxAttempts = Math.max(1, Number(payload.maxAttempts || leadOperationsConfig.outboundMaxAttempts));
  const existing = operationKey ? readByOperationKey(operationKey) : null;

  if (existing) {
    existing.deduplicatedCalls = Number(existing.deduplicatedCalls || 0) + 1;
    existing.lastRequestedAt = at;

    if (existing.status === STATUS.SENT) {
      existing.updatedAt = at;
      writeRecord(existing);
      return { record: existing, shouldSend: false, reason: 'ALREADY_SENT' };
    }

    if (existing.status === STATUS.PENDING) {
      if ((now - timestamp(existing.updatedAt || existing.createdAt)) >= uncertainAfterMs) {
        existing.status = STATUS.UNCERTAIN;
        existing.updatedAt = at;
        existing.lastError = 'Processo reiniciado ou envio não confirmado dentro da janela segura.';
        existing.history = appendHistory(existing, STATUS.UNCERTAIN, 'stale_pending', at);
        writeRecord(existing);
        return { record: existing, shouldSend: false, reason: 'UNCERTAIN' };
      }
      existing.updatedAt = at;
      writeRecord(existing);
      return { record: existing, shouldSend: false, reason: 'IN_FLIGHT' };
    }

    if (existing.status === STATUS.UNCERTAIN || existing.status === STATUS.FAILED_FINAL) {
      existing.updatedAt = at;
      writeRecord(existing);
      return { record: existing, shouldSend: false, reason: existing.status };
    }

    if (existing.status === STATUS.FAILED_RETRYABLE) {
      if (Number(existing.attempts || 0) >= maxAttempts) {
        existing.status = STATUS.FAILED_FINAL;
        existing.updatedAt = at;
        existing.history = appendHistory(existing, STATUS.FAILED_FINAL, 'max_attempts_reached', at);
        writeRecord(existing);
        return { record: existing, shouldSend: false, reason: STATUS.FAILED_FINAL };
      }
      existing.status = STATUS.PENDING;
      existing.attempts = Number(existing.attempts || 0) + 1;
      existing.updatedAt = at;
      existing.lastError = null;
      existing.history = appendHistory(existing, STATUS.PENDING, 'retry', at);
      return { record: writeRecord(existing), shouldSend: true, reason: 'RETRY' };
    }
  }

  const conversationId = normalizeConversation(payload.conversationId);
  const record = {
    id: createId(payload),
    operationKey,
    conversationId,
    conversationKey: conversationKey(conversationId),
    actor: clean(payload.actor || 'BOT', 40) || 'BOT',
    type: clean(payload.type || 'text', 80) || 'text',
    text: clean(payload.text, 12000) || null,
    caption: clean(payload.caption, 12000) || null,
    filename: clean(payload.filename, 500) || null,
    source: clean(payload.source || 'runtime', 120) || 'runtime',
    inboxIds: [...new Set((payload.inboxIds || []).map((item) => clean(item, 260)).filter(Boolean))],
    sequence: Number(payload.sequence || 0),
    status: STATUS.PENDING,
    attempts: 1,
    deduplicatedCalls: 0,
    createdAt: at,
    updatedAt: at,
    lastRequestedAt: at,
    sentAt: null,
    failedAt: null,
    messageId: null,
    lastError: null,
    result: null,
    history: [{ status: STATUS.PENDING, reason: 'begin', at }],
  };
  return { record: writeRecord(record), shouldSend: true, reason: 'NEW' };
}

function markSent(id, result, options = {}) {
  const record = readRecord(id);
  if (!record) return null;
  const at = nowIso(options.now);
  record.status = STATUS.SENT;
  record.sentAt = at;
  record.updatedAt = at;
  record.messageId = extractMessageId(result) || record.messageId || null;
  record.result = safeResult(result);
  record.lastError = null;
  record.history = appendHistory(record, STATUS.SENT, options.reason || 'whatsapp_confirmed', at);
  return writeRecord(record);
}

function markFailed(id, error, options = {}) {
  const record = readRecord(id);
  if (!record) return null;
  const at = nowIso(options.now);
  const maxAttempts = Math.max(1, Number(options.maxAttempts || leadOperationsConfig.outboundMaxAttempts));
  const final = Number(record.attempts || 0) >= maxAttempts;
  record.status = final ? STATUS.FAILED_FINAL : STATUS.FAILED_RETRYABLE;
  record.failedAt = at;
  record.updatedAt = at;
  record.lastError = errorSummary(error);
  record.history = appendHistory(record, record.status, record.lastError, at);
  return writeRecord(record);
}

function syntheticResult(record) {
  if (record?.messageId) {
    return { id: { _serialized: record.messageId }, __outboundLedgerReplay: true };
  }
  return { ok: true, __outboundLedgerReplay: true, status: record?.status || null };
}

async function dispatch(payload = {}, send) {
  if (typeof send !== 'function') throw new TypeError('OUTBOUND_SEND_REQUIRED');
  if (!leadOperationsConfig.outboundLedgerEnabled) return send();

  const started = begin(payload);
  if (!started.shouldSend) {
    if (started.reason === STATUS.FAILED_FINAL) {
      const error = new Error(started.record?.lastError || 'Envio excedeu o limite de tentativas.');
      error.code = 'OUTBOUND_LEDGER_FAILED_FINAL';
      throw error;
    }
    if (started.reason === STATUS.UNCERTAIN || started.reason === 'UNCERTAIN') {
      console.warn(
        `[LEDGER SAÍDA] envio incerto não repetido automaticamente | cliente=${started.record?.conversationId || '-'} `
        + `| operação=${started.record?.operationKey || started.record?.id}`,
      );
    }
    return syntheticResult(started.record);
  }

  try {
    const result = await send(started.record);
    if (result === false || result === null) {
      const error = new Error('WhatsApp não confirmou o envio.');
      error.code = 'OUTBOUND_NOT_CONFIRMED';
      throw error;
    }
    markSent(started.record.id, result);
    return result;
  } catch (error) {
    markFailed(started.record.id, error);
    throw error;
  }
}

function markStalePendingUncertain(options = {}) {
  const now = Number(options.now || Date.now());
  const threshold = Math.max(
    30000,
    Number(options.uncertainAfterMs || leadOperationsConfig.outboundUncertainAfterMs),
  );
  let changed = 0;
  for (const record of listAll()) {
    if (record.status !== STATUS.PENDING) continue;
    if ((now - timestamp(record.updatedAt || record.createdAt)) < threshold) continue;
    record.status = STATUS.UNCERTAIN;
    record.updatedAt = nowIso(now);
    record.lastError = 'Envio estava pendente quando o processo foi retomado; revisão manual necessária.';
    record.history = appendHistory(record, STATUS.UNCERTAIN, 'startup_stale_pending', record.updatedAt);
    writeRecord(record);
    changed += 1;
  }
  return changed;
}

function listConversation(clientId, options = {}) {
  const normalized = normalizeConversation(clientId);
  const key = conversationKey(clientId);
  let aliases = [];
  try { aliases = Identity.getLabelCandidateIds(clientId); } catch (_) {}
  const accepted = new Set([normalized, ...aliases.map(normalizeConversation)].filter(Boolean));
  const after = timestamp(options.after);
  const before = timestamp(options.before) || Number.MAX_SAFE_INTEGER;
  const statuses = options.statuses ? new Set(options.statuses) : null;

  return listAll()
    .filter((record) => {
      if (record.conversationKey && key && record.conversationKey === key) return true;
      return accepted.has(normalizeConversation(record.conversationId));
    })
    .filter((record) => !statuses || statuses.has(record.status))
    .filter((record) => {
      const at = timestamp(record.sentAt || record.createdAt);
      return at > after && at <= before;
    })
    .sort((a, b) => timestamp(a.sentAt || a.createdAt) - timestamp(b.sentAt || b.createdAt));
}

function stats() {
  const output = { total: 0 };
  for (const record of listAll()) {
    output.total += 1;
    output[record.status] = Number(output[record.status] || 0) + 1;
  }
  return output;
}

function purge(options = {}) {
  const now = Number(options.now || Date.now());
  const ttlMs = Math.max(30, Number(options.ttlDays || leadOperationsConfig.outboundTtlDays)) * 86400000;
  const failedTtlMs = Math.max(30, Number(options.failedTtlDays || leadOperationsConfig.outboundFailedTtlDays)) * 86400000;
  const maxEntries = Math.max(5000, Number(options.maxEntries || leadOperationsConfig.outboundMaxEntries));
  const records = listAll().sort((a, b) => timestamp(a.updatedAt) - timestamp(b.updatedAt));
  let removed = 0;

  for (const record of records) {
    if (record.status === STATUS.PENDING) continue;
    const limit = [STATUS.FAILED_FINAL, STATUS.UNCERTAIN].includes(record.status) ? failedTtlMs : ttlMs;
    if ((now - timestamp(record.updatedAt)) > limit && deleteRecord(record.id)) removed += 1;
  }

  const remaining = listAll().sort((a, b) => timestamp(a.updatedAt) - timestamp(b.updatedAt));
  for (const record of remaining) {
    if ((remaining.length - removed) <= maxEntries) break;
    if (record.status === STATUS.PENDING) continue;
    if (deleteRecord(record.id)) removed += 1;
  }
  return { removed, stats: stats() };
}

module.exports = {
  STATUS,
  TERMINAL,
  begin,
  deleteRecord,
  dispatch,
  errorSummary,
  extractMessageId,
  listAll,
  listConversation,
  markFailed,
  markSent,
  markStalePendingUncertain,
  normalizeConversation,
  purge,
  readByOperationKey,
  readRecord,
  stats,
  writeRecord,
};
