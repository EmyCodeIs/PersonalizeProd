'use strict';

const path = require('path');
const Identity = require('./contactIdentity');
const Persistence = require('./persistence');
const ResetCheckpoint = require('./resetCheckpointStore');
const { env } = require('../config/env');

const DATA_DIR = path.join(process.cwd(), 'data');
const STORE_PATH = path.join(DATA_DIR, 'bot-activity.json');

function readState() {
  const parsed = Persistence.readJson(STORE_PATH, { contacts: {}, lastSavedAt: null });
  return {
    contacts: parsed?.contacts && typeof parsed.contacts === 'object' ? parsed.contacts : {},
    lastSavedAt: parsed?.lastSavedAt || null,
  };
}

const state = readState();

function normalizeChatId(value) {
  try {
    return Identity.normalizeChatId(value);
  } catch (_) {
    return String(value || '').trim().toLowerCase();
  }
}

function candidateKeys(clientId) {
  const values = [];
  try { values.push(Identity.getSessionKey(clientId)); } catch (_) {}
  values.push(normalizeChatId(clientId));
  try {
    if (typeof Identity.getLabelCandidateIds === 'function') {
      values.push(...Identity.getLabelCandidateIds(clientId));
    }
  } catch (_) {}
  return [...new Set(values.map((item) => String(item || '').trim()).filter(Boolean))];
}

function persist() {
  state.lastSavedAt = new Date().toISOString();
  Persistence.writeJson(STORE_PATH, state);
}

function recordTimestamp(record) {
  const timestamp = new Date(record?.at || 0).getTime();
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : 0;
}

function recordExpired(record, now = Date.now()) {
  const timestamp = recordTimestamp(record);
  if (!timestamp) return true;
  const ttlMs = Math.max(1, Number(env.botActivityTtlDays || 30)) * 24 * 60 * 60 * 1000;
  return timestamp <= (now - ttlMs);
}

function enforceMaxEntries() {
  const maxEntries = Math.max(500, Number(env.runtimeCacheMaxEntries || 5000));
  const entries = Object.entries(state.contacts || {});
  if (entries.length <= maxEntries) return false;

  entries.sort(([, a], [, b]) => recordTimestamp(a) - recordTimestamp(b));
  const removeCount = entries.length - maxEntries;
  for (let index = 0; index < removeCount; index += 1) {
    delete state.contacts[entries[index][0]];
  }
  return removeCount > 0;
}

function purgeExpired({ write = true } = {}) {
  const now = Date.now();
  let changed = false;

  for (const [key, record] of Object.entries(state.contacts || {})) {
    if (!recordExpired(record, now)) continue;
    delete state.contacts[key];
    changed = true;
  }

  if (enforceMaxEntries()) changed = true;
  if (changed && write) persist();
  return changed;
}

function markBotOutbound(clientId, payload = {}) {
  purgeExpired({ write: false });
  const keys = candidateKeys(clientId);
  if (!keys.length) return null;

  const record = {
    chatId: normalizeChatId(clientId) || null,
    at: payload.at || new Date().toISOString(),
    messageId: String(payload.messageId || '').trim() || null,
    type: String(payload.type || 'text').trim().toLowerCase() || 'text',
  };

  for (const key of keys) state.contacts[key] = record;
  enforceMaxEntries();
  persist();
  return record;
}

function getLastBotOutbound(clientId) {
  let changed = false;
  let latest = null;

  for (const key of candidateKeys(clientId)) {
    const record = state.contacts[key];
    if (!record) continue;

    if (recordExpired(record)) {
      delete state.contacts[key];
      changed = true;
      continue;
    }

    if (!latest || recordTimestamp(record) > recordTimestamp(latest)) latest = record;
  }

  const reset = ResetCheckpoint.getLastReset(clientId);
  if (reset && (!latest || recordTimestamp(reset) > recordTimestamp(latest))) {
    latest = {
      chatId: reset.chatId || normalizeChatId(clientId) || null,
      at: reset.at,
      messageId: reset.messageId || null,
      type: 'reset',
      resetGeneration: reset.generation,
    };
  }

  if (changed) persist();
  return latest ? { ...latest } : null;
}

function clearContact(clientId) {
  let changed = false;
  for (const key of candidateKeys(clientId)) {
    if (!state.contacts[key]) continue;
    delete state.contacts[key];
    changed = true;
  }
  if (changed) persist();
  return changed;
}

function resetAll() {
  state.contacts = {};
  persist();
}

purgeExpired({ write: false });

if (!global.__personalizeBotActivityMaintenanceTimer) {
  const intervalMs = Math.max(60000, Number(env.maintenanceIntervalMs || 900000));
  const timer = setInterval(() => {
    try { purgeExpired(); } catch (error) {
      console.warn('[BOT-ACTIVITY] falha ao limpar checkpoints antigos:', error?.message || error);
    }
  }, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  global.__personalizeBotActivityMaintenanceTimer = timer;
}

module.exports = {
  clearContact,
  markBotOutbound,
  getLastBotOutbound,
  purgeExpired,
  resetAll,
  _test: {
    candidateKeys,
    enforceMaxEntries,
    normalizeChatId,
    recordExpired,
    recordTimestamp,
  },
};
