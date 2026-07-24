'use strict';

const path = require('path');
const Identity = require('./contactIdentity');
const Persistence = require('./persistence');
const { env } = require('../config/env');
const { isTesterIdentity } = require('../core/testCommandAccess');

const DATA_DIR = path.join(process.cwd(), 'data');
const HUMAN_CONTROL_PATH = path.join(DATA_DIR, 'human-control.json');

function readJson(filePath, fallback) {
  return Persistence.readJson(filePath, fallback);
}

function writeJson(filePath, data) {
  return Persistence.writeJson(filePath, data);
}

function nowIso() {
  return new Date().toISOString();
}

function toFiniteTimestamp(value) {
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function addHoursIso(baseIso, hours) {
  const baseTimestamp = toFiniteTimestamp(baseIso) || Date.now();
  const safeHours = Math.max(1, Number(hours || 0));
  return new Date(baseTimestamp + (safeHours * 60 * 60 * 1000)).toISOString();
}

function cleanText(value, maxLength = 120) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, maxLength) : null;
}

function normalizeClientId(clientId) {
  return Identity.getSessionKey(clientId);
}

function normalizeBlock(control) {
  if (!control || typeof control !== 'object') return null;
  const blockedAt = cleanText(control.blockedAt, 80) || nowIso();
  const blockedUntil = cleanText(control.blockedUntil, 80);
  const untilTimestamp = toFiniteTimestamp(blockedUntil);
  if (blockedUntil && untilTimestamp && untilTimestamp <= Date.now()) return null;

  return {
    reason: cleanText(control.reason, 80) || 'human_block',
    source: cleanText(control.source, 80) || 'manual',
    seller: cleanText(control.seller, 80),
    labelName: cleanText(control.labelName, 120),
    blockedAt,
    blockedUntil: blockedUntil || null,
  };
}

const state = readJson(HUMAN_CONTROL_PATH, { blocks: {}, lastSavedAt: null });
if (!state.blocks || typeof state.blocks !== 'object') state.blocks = {};

function persist() {
  state.lastSavedAt = nowIso();
  writeJson(HUMAN_CONTROL_PATH, state);
}

function purgeExpiredBlocks({ write = true } = {}) {
  let changed = false;
  for (const [clientId, block] of Object.entries(state.blocks || {})) {
    const normalized = normalizeBlock(block);
    if (!normalized) {
      delete state.blocks[clientId];
      changed = true;
      continue;
    }
    if (state.blocks[clientId] !== normalized) {
      state.blocks[clientId] = normalized;
      changed = true;
    }
  }
  if (changed && write) persist();
  return changed;
}

function getBlock(clientId) {
  const id = normalizeClientId(clientId);
  if (!id) return { blocked: false, control: null };
  if (isTesterIdentity({ from: clientId })) {
    if (state.blocks[id]) {
      delete state.blocks[id];
      persist();
    }
    return { blocked: false, control: null, testerBypass: true };
  }
  const normalized = normalizeBlock(state.blocks[id]);
  if (!normalized) {
    if (state.blocks[id]) {
      delete state.blocks[id];
      persist();
    }
    return { blocked: false, control: null };
  }
  state.blocks[id] = normalized;
  return { blocked: true, control: normalized };
}

function setBlock(clientId, payload = {}) {
  const id = normalizeClientId(clientId);
  if (!id) return null;
  if (isTesterIdentity({ from: clientId })) {
    if (state.blocks[id]) {
      delete state.blocks[id];
      persist();
    }
    return null;
  }

  const blockedAt = payload.blockedAt || nowIso();
  const blockedUntil = payload.persistent
    ? null
    : (payload.blockedUntil || addHoursIso(blockedAt, payload.blockedHours || env.humanBlockHours));

  state.blocks[id] = normalizeBlock({
    reason: payload.reason || 'human_block',
    source: payload.source || 'manual',
    seller: payload.seller || null,
    labelName: payload.labelName || null,
    blockedAt,
    blockedUntil,
  });
  persist();
  return state.blocks[id];
}

function clearBlock(clientId) {
  const id = normalizeClientId(clientId);
  if (!id || !state.blocks[id]) return false;
  delete state.blocks[id];
  persist();
  return true;
}

function resetAll() {
  const previousCount = Object.keys(state.blocks || {}).length;
  state.blocks = {};
  persist();
  return previousCount;
}

purgeExpiredBlocks({ write: false });

module.exports = {
  normalizeClientId,
  getBlock,
  setBlock,
  clearBlock,
  purgeExpiredBlocks,
  resetAll,
  _test: {
    addHoursIso,
    cleanText,
    normalizeBlock,
  },
};
