'use strict';

const path = require('path');
const Identity = require('./contactIdentity');
const Persistence = require('./persistence');

const FILE_PATH = path.join(process.cwd(), 'data', 'handoff-reset-checkpoints.json');
const state = Persistence.readJson(FILE_PATH, { contacts: {}, updatedAt: null });
if (!state.contacts || typeof state.contacts !== 'object') state.contacts = {};

function keyFor(clientId) {
  try { return String(Identity.getSessionKey(clientId) || '').trim(); } catch (_) { return ''; }
}

function persist() {
  state.updatedAt = new Date().toISOString();
  Persistence.writeJson(FILE_PATH, state);
}

function markReset(clientId, details = {}) {
  const key = keyFor(clientId);
  if (!key) return null;
  const at = details.at || new Date().toISOString();
  state.contacts[key] = {
    at,
    reason: String(details.reason || 'resetarsys').trim() || 'resetarsys',
    chatId: String(clientId || '').trim() || null,
  };
  persist();
  return { ...state.contacts[key] };
}

function getResetCheckpoint(clientId) {
  const key = keyFor(clientId);
  const value = key ? state.contacts[key] : null;
  return value ? { ...value } : null;
}

function clearResetCheckpoint(clientId) {
  const key = keyFor(clientId);
  if (!key || !state.contacts[key]) return false;
  delete state.contacts[key];
  persist();
  return true;
}

module.exports = {
  FILE_PATH,
  clearResetCheckpoint,
  getResetCheckpoint,
  markReset,
  _test: { keyFor, state },
};
