'use strict';

const path = require('path');
const Identity = require('./contactIdentity');
const Persistence = require('./persistence');
const ResetCheckpoint = require('./resetCheckpointStore');
const { recoveryConfig } = require('../config/recoveryConfig');

const STORE_PATH = path.join(process.cwd(), 'data', 'conversation-cursors.json');
const state = Persistence.readJson(STORE_PATH, { version: 1, records: {}, updatedAt: null });
if (!state.records || typeof state.records !== 'object') state.records = {};

function nowIso(now = Date.now()) {
  return new Date(Number(now) || Date.now()).toISOString();
}

function timestamp(value) {
  const parsed = new Date(value || 0).getTime();
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function clean(value, maxLength = 240) {
  const text = String(value ?? '').trim();
  return text ? text.slice(0, maxLength) : '';
}

function normalizeChatId(value) {
  try { return Identity.normalizeChatId(value); } catch (_) {
    return clean(value, 180).toLowerCase();
  }
}

function candidateKeys(clientId) {
  const values = [];
  try { values.push(Identity.getSessionKey(clientId)); } catch (_) {}
  values.push(normalizeChatId(clientId));
  try { values.push(...Identity.getLabelCandidateIds(clientId)); } catch (_) {}
  return [...new Set(values.map((item) => clean(item, 240)).filter(Boolean))];
}

function persist() {
  state.version = 1;
  state.updatedAt = nowIso();
  Persistence.writeJson(STORE_PATH, state);
}

function clone(value) {
  return value ? JSON.parse(JSON.stringify(value)) : value;
}

function effectiveReset(clientId, record = null) {
  let checkpoint = null;
  try { checkpoint = ResetCheckpoint.getLastReset(clientId); } catch (_) {}
  const recordAt = timestamp(record?.resetAt);
  const checkpointAt = timestamp(checkpoint?.at);
  if (!checkpoint || recordAt >= checkpointAt) {
    return recordAt ? {
      at: record.resetAt,
      generation: record.resetGeneration || null,
      messageId: record.resetMessageId || null,
    } : null;
  }
  return {
    at: checkpoint.at,
    generation: checkpoint.generation || null,
    messageId: checkpoint.messageId || null,
  };
}

function readRaw(clientId) {
  let latest = null;
  for (const key of candidateKeys(clientId)) {
    const record = state.records[key];
    if (!record) continue;
    if (!latest || timestamp(record.updatedAt) > timestamp(latest.updatedAt)) latest = record;
  }
  return latest ? clone(latest) : null;
}

function getCursor(clientId) {
  const record = readRaw(clientId);
  if (!record) return null;
  const reset = effectiveReset(clientId, record);
  if (reset && timestamp(reset.at) > timestamp(record.resetAt)) {
    record.resetAt = reset.at;
    record.resetGeneration = reset.generation;
    record.resetMessageId = reset.messageId;
  }
  return record;
}

function writeCursor(clientId, patch = {}) {
  const keys = candidateKeys(clientId);
  if (!keys.length) return null;
  const existing = readRaw(clientId) || {};
  const identity = (() => {
    try { return Identity.resolveContact(clientId); } catch (_) { return null; }
  })();
  const aliases = [...new Set([
    ...(existing.aliases || []),
    ...(identity?.aliases || []),
    identity?.primaryChatId,
    identity?.lid,
    identity?.cUsId,
    normalizeChatId(clientId),
  ].map(normalizeChatId).filter(Boolean))];
  const at = nowIso(patch.now);
  const record = {
    ...existing,
    cursorId: existing.cursorId || `cursor:${keys[0]}`,
    conversationKey: identity?.contactKey || existing.conversationKey || keys[0],
    primaryChatId: identity?.primaryChatId || existing.primaryChatId || normalizeChatId(clientId) || null,
    aliases,
    createdAt: existing.createdAt || at,
    ...patch,
    updatedAt: at,
  };
  delete record.now;
  const targetKeys = [...new Set([...keys, record.conversationKey, ...aliases].filter(Boolean))];
  for (const key of targetKeys) state.records[key] = record;
  persist();
  return clone(record);
}

function messageMeta(input = {}) {
  const raw = input.raw && typeof input.raw === 'object' ? input.raw : input;
  const id = clean(
    input.messageId
    || raw?.__personalizeOriginalMessageId
    || raw?.id?._serialized
    || (typeof raw?.id === 'string' ? raw.id : '')
    || raw?.messageId
    || raw?.key?.id,
    260,
  ) || null;
  const values = [
    input.sourceTimestamp,
    raw?.timestamp,
    raw?.t,
    raw?.messageTimestamp,
    raw?.id?.timestamp,
    input.receivedAt,
  ];
  let at = 0;
  for (const value of values) {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) {
      at = numeric < 1000000000000 ? numeric * 1000 : numeric;
      break;
    }
    const parsed = timestamp(value);
    if (parsed) {
      at = parsed;
      break;
    }
  }
  return {
    messageId: id,
    at: at || Date.now(),
    atIso: nowIso(at || Date.now()),
  };
}

function observeReceived(clientId, input = {}) {
  const meta = messageMeta(input);
  const cursor = getCursor(clientId);
  const previousAt = timestamp(cursor?.lastObservedAt);
  if (previousAt > meta.at && cursor) return cursor;
  return writeCursor(clientId, {
    lastObservedMessageId: meta.messageId,
    lastObservedAt: meta.atIso,
    lastCustomerMessageAt: meta.atIso,
    lifecycle: 'ACTIVE',
    lifecycleAt: meta.atIso,
    lifecycleReason: 'customer_message_received',
  });
}

function sessionSnapshot(session = null) {
  if (!session) return null;
  const dados = session.dados && typeof session.dados === 'object' ? session.dados : {};
  return {
    etapa: clean(session.etapa, 80) || 'inicio',
    completed: Boolean(session.completed || dados.botDone || session.etapa === 'concluido'),
    completedAt: session.completedAt || dados.completedAt || null,
    updatedAt: session.updatedAt || session.lastInteractionAt || null,
    lastInteractionAt: session.lastInteractionAt || session.updatedAt || null,
    expiresAt: session.expiresAt || null,
    service: clean(dados.flow, 60) || null,
    customerName: clean(dados.nome, 160) || null,
    city: clean(dados.cidade, 160) || null,
  };
}

function markProcessed(clientId, input = {}, options = {}) {
  const meta = messageMeta(input);
  const cursor = getCursor(clientId) || {};
  const previousAt = timestamp(cursor.lastProcessedAt);
  const patch = {
    lastOutcome: clean(options.outcome || 'PROCESSED', 80),
    lastOutcomeAt: nowIso(options.now),
    session: options.session ? sessionSnapshot(options.session) : cursor.session || null,
  };
  if (meta.at >= previousAt) {
    patch.lastProcessedMessageId = meta.messageId;
    patch.lastProcessedAt = meta.atIso;
  }
  if (patch.session?.completed) {
    patch.lifecycle = 'COMPLETED';
    patch.lifecycleAt = patch.session.completedAt || patch.lastOutcomeAt;
  } else if (cursor.lifecycle === 'RESET') {
    patch.lifecycle = 'ACTIVE';
    patch.lifecycleAt = patch.lastOutcomeAt;
  }
  return writeCursor(clientId, patch);
}

function ensureBaseline(clientId, options = {}) {
  const cursor = getCursor(clientId);
  const baselineAt = timestamp(options.at);
  const patch = {
    session: options.session ? sessionSnapshot(options.session) : cursor?.session || null,
  };
  if (!cursor?.lastProcessedAt && baselineAt) {
    patch.lastProcessedAt = nowIso(baselineAt);
    patch.lastProcessedMessageId = clean(options.messageId, 260) || null;
    patch.baselineSource = clean(options.source || 'session_state', 80);
  }
  if (!cursor?.lifecycle || cursor.lifecycle === 'RESET') {
    patch.lifecycle = patch.session?.completed ? 'COMPLETED' : 'ACTIVE';
    patch.lifecycleAt = nowIso();
  }
  return writeCursor(clientId, patch);
}

function markReset(clientId, payload = {}) {
  const at = payload.at || nowIso(payload.now);
  return writeCursor(clientId, {
    resetAt: at,
    resetGeneration: payload.generation || null,
    resetMessageId: clean(payload.messageId, 260) || null,
    lastProcessedMessageId: null,
    lastProcessedAt: null,
    lastObservedMessageId: null,
    lastObservedAt: null,
    lastCustomerMessageAt: null,
    lifecycle: 'RESET',
    lifecycleAt: at,
    lastOutcome: 'RESET',
    lastOutcomeAt: at,
    session: null,
  });
}

function shouldRecover(clientId, input = {}, options = {}) {
  const meta = messageMeta(input);
  const cursor = getCursor(clientId);
  const reset = effectiveReset(clientId, cursor);
  const resetAt = timestamp(reset?.at);
  if (resetAt && meta.at <= resetAt) return { recover: false, reason: 'BEFORE_RESET', meta, cursor };

  const maxAgeHours = Math.max(1, Number(options.maxAgeHours || recoveryConfig.maxAgeHours));
  const oldest = Number(options.now || Date.now()) - (maxAgeHours * 3600000);
  if (meta.at < oldest) return { recover: false, reason: 'TOO_OLD', meta, cursor };

  if (!cursor?.lastProcessedAt) return { recover: true, reason: 'NO_CURSOR', meta, cursor };
  if (meta.messageId && meta.messageId === cursor.lastProcessedMessageId) {
    return { recover: false, reason: 'ALREADY_PROCESSED_ID', meta, cursor };
  }

  const processedAt = timestamp(cursor.lastProcessedAt);
  const graceMs = cursor.lastProcessedMessageId
    ? 0
    : Math.max(0, Number(options.graceMs || 0));
  if (meta.at <= (processedAt + graceMs)) {
    return { recover: false, reason: 'BEFORE_CURSOR', meta, cursor };
  }
  return { recover: true, reason: 'AFTER_CURSOR', meta, cursor };
}

function markRecovery(clientId, payload = {}) {
  return writeCursor(clientId, {
    lastRecoveryAt: payload.at || nowIso(payload.now),
    lastRecoverySource: clean(payload.source, 100) || 'unknown',
    lastRecoveryFound: Math.max(0, Number(payload.found || 0)),
    lastRecoveryStaged: Math.max(0, Number(payload.staged || 0)),
    lastRecoverySkipped: Math.max(0, Number(payload.skipped || 0)),
  });
}

function markLifecycle(clientId, lifecycle, payload = {}) {
  const current = getCursor(clientId) || {};
  const target = clean(lifecycle, 80).toUpperCase() || 'ACTIVE';
  const reason = clean(payload.reason, 200) || null;
  const nextSession = payload.session ? sessionSnapshot(payload.session) : current.session || null;
  const unchanged = current.lifecycle === target
    && current.lifecycleReason === reason
    && JSON.stringify(current.session || null) === JSON.stringify(nextSession || null);
  if (unchanged) return current;
  return writeCursor(clientId, {
    lifecycle: target,
    lifecycleAt: payload.at || nowIso(payload.now),
    lifecycleReason: reason,
    session: nextSession,
  });
}

function listAll() {
  const unique = new Map();
  for (const record of Object.values(state.records || {})) {
    if (!record?.cursorId) continue;
    const current = unique.get(record.cursorId);
    if (!current || timestamp(record.updatedAt) > timestamp(current.updatedAt)) {
      unique.set(record.cursorId, clone(record));
    }
  }
  return [...unique.values()];
}

function purge(options = {}) {
  const ttlDays = Math.max(30, Number(options.ttlDays || recoveryConfig.cursorTtlDays));
  const oldest = Number(options.now || Date.now()) - (ttlDays * 86400000);
  const removable = new Set(
    listAll()
      .filter((record) => timestamp(record.updatedAt) < oldest)
      .map((record) => record.cursorId),
  );
  if (!removable.size) return 0;
  let removed = 0;
  for (const [key, record] of Object.entries(state.records || {})) {
    if (!removable.has(record?.cursorId)) continue;
    delete state.records[key];
    removed += 1;
  }
  persist();
  return removed;
}

function stats() {
  const output = { total: 0 };
  for (const record of listAll()) {
    output.total += 1;
    const key = clean(record.lifecycle || 'UNKNOWN', 80).toUpperCase();
    output[key] = Number(output[key] || 0) + 1;
  }
  return output;
}

purge({});

module.exports = {
  candidateKeys,
  effectiveReset,
  ensureBaseline,
  getCursor,
  listAll,
  markLifecycle,
  markProcessed,
  markRecovery,
  markReset,
  messageMeta,
  observeReceived,
  purge,
  sessionSnapshot,
  shouldRecover,
  stats,
  timestamp,
  writeCursor,
};
