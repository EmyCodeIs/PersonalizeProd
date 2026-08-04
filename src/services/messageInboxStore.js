'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Persistence = require('./persistence');

const DATA_DIR = path.resolve(process.cwd(), 'data');
const FILE_PATH = path.join(DATA_DIR, 'message-inbox.json');
const SQLITE_TABLE = 'secure_inbox_messages';

const STATUS = Object.freeze({
  RECEIVED: 'RECEIVED',
  BUFFERED: 'BUFFERED',
  QUEUED: 'QUEUED',
  PROCESSING: 'PROCESSING',
  PROCESSED: 'PROCESSED',
  IGNORED_HANDOFF: 'IGNORED_HANDOFF',
  IGNORED_POLICY: 'IGNORED_POLICY',
  FAILED_RETRYABLE: 'FAILED_RETRYABLE',
  FAILED_FINAL: 'FAILED_FINAL',
  RESET: 'RESET',
});

const TERMINAL = new Set([
  STATUS.PROCESSED,
  STATUS.IGNORED_HANDOFF,
  STATUS.IGNORED_POLICY,
  STATUS.FAILED_FINAL,
  STATUS.RESET,
]);

const state = {
  records: {},
  loaded: false,
};

function nowIso(now = Date.now()) {
  return new Date(Number(now) || Date.now()).toISOString();
}

function timestamp(value) {
  const parsed = new Date(value || 0).getTime();
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function cleanText(value, maxLength = 4000) {
  const text = String(value ?? '').trim();
  return text ? text.slice(0, maxLength) : '';
}

function normalizeConversation(value) {
  const raw = cleanText(value, 180).toLowerCase();
  if (!raw) return '';
  if (/@(?:c\.us|lid|g\.us)$/i.test(raw)) return raw;
  const digits = raw.replace(/\D/g, '');
  return digits ? `${digits}@c.us` : raw;
}

function originalMessageId(raw = {}) {
  return cleanText(
    raw?.__personalizeOriginalMessageId
    || raw?.id?._serialized
    || (typeof raw?.id === 'string' ? raw.id : '')
    || raw?.messageId
    || raw?.key?.id
    || '',
    240,
  ) || null;
}

function rawTimestamp(raw = {}) {
  const values = [raw?.timestamp, raw?.t, raw?.messageTimestamp, raw?.id?.timestamp];
  for (const value of values) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) continue;
    return numeric < 1000000000000 ? numeric * 1000 : numeric;
  }
  return null;
}

function safeRaw(raw = {}) {
  const id = originalMessageId(raw);
  return {
    id: id ? { _serialized: id } : null,
    from: cleanText(raw?.from || raw?.chatId || raw?.id?.remote || raw?.key?.remoteJid, 180) || null,
    to: cleanText(raw?.to, 180) || null,
    timestamp: rawTimestamp(raw),
    type: cleanText(raw?.type, 60) || null,
    mimetype: cleanText(raw?.mimetype, 160) || null,
    mediaType: cleanText(raw?.mediaType, 60) || null,
    filename: cleanText(raw?.filename || raw?.fileName || raw?.document?.filename, 240) || null,
    caption: cleanText(raw?.caption, 4000) || null,
    body: cleanText(raw?.body, 4000) || null,
    text: cleanText(raw?.text, 4000) || null,
    selectedRowId: cleanText(raw?.selectedRowId, 240) || null,
    selectedButtonId: cleanText(raw?.selectedButtonId, 240) || null,
    notifyName: cleanText(raw?.notifyName || raw?.pushname, 180) || null,
    isGroupMsg: Boolean(raw?.isGroupMsg),
    fromMe: Boolean(raw?.fromMe),
  };
}

function stableKey(payload = {}) {
  const explicit = cleanText(payload.inboxId, 260);
  if (explicit) return explicit;

  const messageId = originalMessageId(payload.raw || {});
  if (messageId) return `msg:${messageId}`;

  const raw = payload.raw || {};
  const fingerprint = [
    normalizeConversation(payload.conversationId || payload.from || raw?.from),
    cleanText(payload.interactiveId, 240),
    cleanText(payload.text || raw?.body || raw?.caption || raw?.text, 4000),
    cleanText(raw?.type || raw?.mimetype || raw?.mediaType, 120),
    rawTimestamp(raw) || '',
  ].join('|');

  return `fp:${crypto.createHash('sha256').update(fingerprint).digest('hex')}`;
}

function storageIsSqlite() {
  return Persistence.storageInfo().driver === 'sqlite';
}

function ensureSqlite() {
  if (!storageIsSqlite()) return null;
  const db = Persistence.getDatabase();
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${SQLITE_TABLE} (
      message_key TEXT PRIMARY KEY,
      conversation_key TEXT NOT NULL,
      status TEXT NOT NULL,
      available_at TEXT,
      lease_expires_at TEXT,
      received_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      encrypted_payload TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_secure_inbox_status_available
      ON ${SQLITE_TABLE}(status, available_at, updated_at);

    CREATE INDEX IF NOT EXISTS idx_secure_inbox_conversation
      ON ${SQLITE_TABLE}(conversation_key, updated_at);
  `);
  return db;
}

function ensureFileState() {
  if (storageIsSqlite() || state.loaded) return;
  const parsed = Persistence.readJson(FILE_PATH, { records: {} });
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

function serializeRecord(record) {
  return Persistence.encryptText(JSON.stringify(record));
}

function deserializeRecord(value) {
  return JSON.parse(Persistence.decryptText(value));
}

function readRecord(key) {
  const id = cleanText(key, 260);
  if (!id) return null;

  if (!storageIsSqlite()) {
    ensureFileState();
    return state.records[id] ? { ...state.records[id] } : null;
  }

  const row = ensureSqlite().prepare(
    `SELECT encrypted_payload FROM ${SQLITE_TABLE} WHERE message_key = ?`,
  ).get(id);
  return row?.encrypted_payload ? deserializeRecord(row.encrypted_payload) : null;
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
      message_key, conversation_key, status, available_at,
      lease_expires_at, received_at, updated_at, encrypted_payload
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(message_key) DO UPDATE SET
      conversation_key = excluded.conversation_key,
      status = excluded.status,
      available_at = excluded.available_at,
      lease_expires_at = excluded.lease_expires_at,
      received_at = excluded.received_at,
      updated_at = excluded.updated_at,
      encrypted_payload = excluded.encrypted_payload
  `).run(
    next.id,
    next.conversationId || '-',
    next.status,
    next.availableAt || null,
    next.leaseExpiresAt || null,
    next.receivedAt,
    next.updatedAt,
    serializeRecord(next),
  );
  return { ...next };
}

function deleteRecord(key) {
  const id = cleanText(key, 260);
  if (!id) return false;
  if (!storageIsSqlite()) {
    ensureFileState();
    if (!state.records[id]) return false;
    delete state.records[id];
    persistFileState();
    return true;
  }
  return Number(ensureSqlite().prepare(
    `DELETE FROM ${SQLITE_TABLE} WHERE message_key = ?`,
  ).run(id)?.changes || 0) > 0;
}

function listAll() {
  if (!storageIsSqlite()) {
    ensureFileState();
    return Object.values(state.records).map((item) => ({ ...item }));
  }

  const rows = ensureSqlite().prepare(
    `SELECT encrypted_payload FROM ${SQLITE_TABLE} ORDER BY updated_at ASC`,
  ).all();
  return rows.map((row) => deserializeRecord(row.encrypted_payload));
}

function appendHistory(record, status, reason = null, at = nowIso()) {
  const history = Array.isArray(record.history) ? [...record.history] : [];
  history.push({ status, reason: cleanText(reason, 500) || null, at });
  return history.slice(-20);
}

function receive(payload = {}) {
  const id = stableKey(payload);
  const existing = readRecord(id);
  const at = nowIso(payload.now);

  if (existing) {
    existing.duplicateCount = Number(existing.duplicateCount || 0) + 1;
    existing.lastSeenAt = at;
    existing.sources = [...new Set([...(existing.sources || []), cleanText(payload.source, 80)].filter(Boolean))].slice(-10);
    existing.updatedAt = at;
    writeRecord(existing);
    return { record: existing, duplicate: true };
  }

  const raw = safeRaw(payload.raw || {});
  const conversationId = normalizeConversation(payload.conversationId || payload.from || raw.from);
  const record = {
    id,
    messageId: originalMessageId(payload.raw || {}),
    conversationId,
    from: normalizeConversation(payload.from || raw.from || conversationId),
    text: cleanText(payload.text || raw.body || raw.caption || raw.text, 4000),
    interactiveId: cleanText(payload.interactiveId, 240) || null,
    profileName: cleanText(payload.profileName || raw.notifyName, 180) || null,
    raw,
    status: STATUS.RECEIVED,
    attempts: 0,
    duplicateCount: 0,
    sources: [cleanText(payload.source, 80) || 'event'],
    receivedAt: at,
    lastSeenAt: at,
    updatedAt: at,
    availableAt: at,
    leaseOwner: null,
    leaseExpiresAt: null,
    processingStartedAt: null,
    processedAt: null,
    lastError: null,
    history: [{ status: STATUS.RECEIVED, reason: null, at }],
  };
  writeRecord(record);
  return { record, duplicate: false };
}

function updateMany(ids = [], updater) {
  const output = [];
  for (const id of [...new Set(ids.map((item) => cleanText(item, 260)).filter(Boolean))]) {
    const current = readRecord(id);
    if (!current) continue;
    const next = updater({ ...current });
    if (!next) continue;
    next.updatedAt = next.updatedAt || nowIso();
    output.push(writeRecord(next));
  }
  return output;
}

function transition(ids, status, payload = {}) {
  const at = nowIso(payload.now);
  return updateMany(ids, (record) => ({
    ...record,
    ...payload.patch,
    status,
    conversationId: normalizeConversation(payload.conversationId || record.conversationId),
    updatedAt: at,
    history: appendHistory(record, status, payload.reason, at),
  }));
}

function markBuffered(ids, payload = {}) {
  return transition(ids, STATUS.BUFFERED, payload);
}

function markQueued(ids, payload = {}) {
  return transition(ids, STATUS.QUEUED, payload);
}

function isLeaseExpired(record, now = Date.now()) {
  return !record?.leaseExpiresAt || timestamp(record.leaseExpiresAt) <= Number(now);
}

function claimBatch(ids, options = {}) {
  const owner = cleanText(options.owner, 180) || `runtime:${process.pid}`;
  const now = Number(options.now || Date.now());
  const at = nowIso(now);
  const leaseMs = Math.max(1000, Number(options.leaseMs || 120000));
  const claimed = [];

  for (const id of [...new Set(ids.map((item) => cleanText(item, 260)).filter(Boolean))]) {
    const record = readRecord(id);
    if (!record || TERMINAL.has(record.status)) continue;

    if (record.status === STATUS.PROCESSING && !isLeaseExpired(record, now)) continue;
    if (record.status === STATUS.FAILED_RETRYABLE && timestamp(record.availableAt) > now) continue;

    record.status = STATUS.PROCESSING;
    record.attempts = Number(record.attempts || 0) + 1;
    record.leaseOwner = owner;
    record.leaseExpiresAt = nowIso(now + leaseMs);
    record.processingStartedAt = at;
    record.availableAt = null;
    record.updatedAt = at;
    record.history = appendHistory(record, STATUS.PROCESSING, options.reason || 'claimed', at);
    claimed.push(writeRecord(record));
  }

  return claimed;
}

function renewLease(ids, options = {}) {
  const owner = cleanText(options.owner, 180);
  const now = Number(options.now || Date.now());
  const leaseMs = Math.max(1000, Number(options.leaseMs || 120000));
  return updateMany(ids, (record) => {
    if (record.status !== STATUS.PROCESSING) return null;
    if (owner && record.leaseOwner && record.leaseOwner !== owner) return null;
    record.leaseOwner = owner || record.leaseOwner;
    record.leaseExpiresAt = nowIso(now + leaseMs);
    record.updatedAt = nowIso(now);
    return record;
  });
}

function markProcessed(ids, payload = {}) {
  const at = nowIso(payload.now);
  return updateMany(ids, (record) => ({
    ...record,
    status: STATUS.PROCESSED,
    processedAt: at,
    updatedAt: at,
    availableAt: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    lastError: null,
    history: appendHistory(record, STATUS.PROCESSED, payload.reason || 'flow_completed', at),
  }));
}

function markIgnored(ids, status = STATUS.IGNORED_POLICY, payload = {}) {
  const target = status === STATUS.IGNORED_HANDOFF ? status : STATUS.IGNORED_POLICY;
  const at = nowIso(payload.now);
  return updateMany(ids, (record) => ({
    ...record,
    status: target,
    processedAt: at,
    updatedAt: at,
    availableAt: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    lastError: payload.reason || null,
    history: appendHistory(record, target, payload.reason, at),
  }));
}

function errorSummary(error) {
  if (!error) return 'UNKNOWN_ERROR';
  const code = cleanText(error.code, 100);
  const message = cleanText(error.message || error, 600);
  return [code, message].filter(Boolean).join(': ') || 'UNKNOWN_ERROR';
}

function markFailure(ids, error, options = {}) {
  const now = Number(options.now || Date.now());
  const at = nowIso(now);
  const maxAttempts = Math.max(1, Number(options.maxAttempts || 3));
  const baseDelayMs = Math.max(1000, Number(options.baseDelayMs || 5000));
  const maxDelayMs = Math.max(baseDelayMs, Number(options.maxDelayMs || 900000));
  const summary = errorSummary(error);

  return updateMany(ids, (record) => {
    const attempts = Math.max(1, Number(record.attempts || 0));
    const final = attempts >= maxAttempts;
    const delayMs = Math.min(maxDelayMs, baseDelayMs * (2 ** Math.max(0, attempts - 1)));
    const status = final ? STATUS.FAILED_FINAL : STATUS.FAILED_RETRYABLE;
    return {
      ...record,
      status,
      attempts,
      updatedAt: at,
      availableAt: final ? null : nowIso(now + delayMs),
      leaseOwner: null,
      leaseExpiresAt: null,
      lastError: summary,
      history: appendHistory(record, status, summary, at),
    };
  });
}

function markResetForConversation(clientId, aliases = [], options = {}) {
  const targets = new Set(
    [clientId, ...aliases].map(normalizeConversation).filter(Boolean),
  );
  const ids = listAll()
    .filter((record) => targets.has(normalizeConversation(record.conversationId)) || targets.has(normalizeConversation(record.from)))
    .filter((record) => !TERMINAL.has(record.status) || record.status === STATUS.FAILED_FINAL)
    .map((record) => record.id);
  return transition(ids, STATUS.RESET, {
    now: options.now,
    reason: options.reason || 'conversation_reset',
    patch: {
      processedAt: nowIso(options.now),
      availableAt: null,
      leaseOwner: null,
      leaseExpiresAt: null,
    },
  });
}

function requeueForReplay(id, options = {}) {
  const record = readRecord(id);
  if (!record || TERMINAL.has(record.status)) return null;
  const at = nowIso(options.now);
  const reason = record.status === STATUS.PROCESSING && isLeaseExpired(record, options.now || Date.now())
    ? 'expired_processing_lease'
    : (options.reason || 'persistent_replay');
  record.status = STATUS.RECEIVED;
  record.updatedAt = at;
  record.availableAt = at;
  record.leaseOwner = null;
  record.leaseExpiresAt = null;
  record.lastError = reason;
  record.history = appendHistory(record, STATUS.RECEIVED, reason, at);
  return writeRecord(record);
}

function listRecoverable(options = {}) {
  const now = Number(options.now || Date.now());
  const staleMs = Math.max(1000, Number(options.staleMs || 30000));
  const limit = Math.max(1, Number(options.limit || 50));

  return listAll()
    .filter((record) => {
      if (TERMINAL.has(record.status)) return false;
      if (record.status === STATUS.FAILED_RETRYABLE) return timestamp(record.availableAt) <= now;
      if (record.status === STATUS.PROCESSING) return isLeaseExpired(record, now);
      return timestamp(record.updatedAt) <= (now - staleMs);
    })
    .sort((a, b) => timestamp(a.receivedAt) - timestamp(b.receivedAt))
    .slice(0, limit);
}

function toReplayPayload(record, options = {}) {
  if (!record) return null;
  const attempt = Number(record.attempts || 0) + 1;
  const replayId = `inbox-replay:${record.id}:${attempt}:${Number(options.now || Date.now())}`;
  return {
    from: record.from || record.conversationId,
    text: record.text,
    source: options.source || 'persistent-inbox-recovery',
    __personalizeInboxReplay: true,
    __personalizeInboxId: record.id,
    raw: {
      ...(record.raw || {}),
      id: { _serialized: replayId },
      __personalizeInboxId: record.id,
      __personalizeOriginalMessageId: record.messageId || null,
      __personalizeInboxReplay: true,
    },
  };
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
  const processedTtlDays = Math.max(1, Number(options.processedTtlDays || 7));
  const failedTtlDays = Math.max(processedTtlDays, Number(options.failedTtlDays || 30));
  const maxEntries = Math.max(1000, Number(options.maxEntries || 20000));
  const records = listAll().sort((a, b) => timestamp(a.updatedAt) - timestamp(b.updatedAt));
  let removed = 0;

  for (const record of records) {
    const ageMs = now - timestamp(record.updatedAt);
    const ttlMs = (record.status === STATUS.FAILED_FINAL ? failedTtlDays : processedTtlDays) * 86400000;
    if (TERMINAL.has(record.status) && ageMs > ttlMs && deleteRecord(record.id)) removed += 1;
  }

  const remaining = listAll().sort((a, b) => timestamp(a.updatedAt) - timestamp(b.updatedAt));
  const removable = remaining.filter((record) => TERMINAL.has(record.status));
  while ((remaining.length - removed) > maxEntries && removable.length) {
    const record = removable.shift();
    if (deleteRecord(record.id)) removed += 1;
  }

  return { removed, stats: stats() };
}

module.exports = {
  STATUS,
  TERMINAL,
  claimBatch,
  deleteRecord,
  errorSummary,
  isLeaseExpired,
  listAll,
  listRecoverable,
  markBuffered,
  markFailure,
  markIgnored,
  markProcessed,
  markQueued,
  markResetForConversation,
  normalizeConversation,
  originalMessageId,
  purge,
  readRecord,
  receive,
  renewLease,
  requeueForReplay,
  safeRaw,
  stableKey,
  stats,
  toReplayPayload,
  transition,
  writeRecord,
};
