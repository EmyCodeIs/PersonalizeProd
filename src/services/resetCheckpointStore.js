'use strict';

const path = require('path');
const Identity = require('./contactIdentity');
const Persistence = require('./persistence');
const { env } = require('../config/env');

const DATA_DIR = path.join(process.cwd(), 'data');
const STORE_PATH = path.join(DATA_DIR, 'reset-checkpoints.json');

const state = Persistence.readJson(STORE_PATH, { contacts: {}, lastSavedAt: null });
if (!state.contacts || typeof state.contacts !== 'object') state.contacts = {};

function nowIso() {
  return new Date().toISOString();
}

function normalizeChatId(value) {
  try { return Identity.normalizeChatId(value); } catch (_) {
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
  state.lastSavedAt = nowIso();
  Persistence.writeJson(STORE_PATH, state);
}

function timestampOf(record) {
  const value = new Date(record?.at || 0).getTime();
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function purgeExpired({ write = true } = {}) {
  const ttlDays = Math.max(30, Number(env.botActivityTtlDays || 30));
  const oldest = Date.now() - (ttlDays * 24 * 60 * 60 * 1000);
  let changed = false;

  for (const [key, record] of Object.entries(state.contacts || {})) {
    if (timestampOf(record) > oldest) continue;
    delete state.contacts[key];
    changed = true;
  }

  if (changed && write) persist();
  return changed;
}

function markReset(clientId, payload = {}) {
  purgeExpired({ write: false });
  const keys = candidateKeys(clientId);
  if (!keys.length) return null;

  const record = {
    chatId: normalizeChatId(clientId) || null,
    at: payload.at || nowIso(),
    messageId: String(payload.messageId || '').trim() || null,
    command: String(payload.command || '/resetarsys').trim().toLowerCase(),
    actor: String(payload.actor || 'test_admin').trim().slice(0, 80),
    mode: String(payload.mode || 'TESTER_FULL').trim().toUpperCase(),
    generation: Math.max(1, Number(payload.generation || Date.now())),
  };

  for (const key of keys) state.contacts[key] = record;
  persist();
  return { ...record };
}

function getLastReset(clientId) {
  let latest = null;
  for (const key of candidateKeys(clientId)) {
    const record = state.contacts[key];
    if (!record) continue;
    if (!latest || timestampOf(record) > timestampOf(latest)) latest = record;
  }
  return latest ? { ...latest } : null;
}

function clearReset(clientId) {
  let changed = false;
  for (const key of candidateKeys(clientId)) {
    if (!state.contacts[key]) continue;
    delete state.contacts[key];
    changed = true;
  }
  if (changed) persist();
  return changed;
}

purgeExpired({ write: false });

module.exports = {
  clearReset,
  getLastReset,
  markReset,
  purgeExpired,
  _test: {
    candidateKeys,
    timestampOf,
  },
};
