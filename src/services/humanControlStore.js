'use strict';

const path = require('path');
const Identity = require('./contactIdentity');
const Persistence = require('./persistence');
const { env } = require('../config/env');

const DATA_DIR = path.join(process.cwd(), 'data');
const HUMAN_CONTROL_PATH = path.join(DATA_DIR, 'human-control.json');
const PERSISTENT_REASONS = new Set([
  'seller_label',
  'manual_label',
  'manual_outbound_message',
  'manual_outbound_history',
]);

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

function candidateBlockIds(clientId) {
  const values = [clientId];
  try { values.push(Identity.getSessionKey(clientId)); } catch (_) {}
  try {
    if (typeof Identity.getLabelCandidateIds === 'function') {
      values.push(...Identity.getLabelCandidateIds(clientId));
    }
  } catch (_) {}
  return [...new Set(values.map(normalizeClientId).filter(Boolean))];
}

function isPersistentReason(reason) {
  return PERSISTENT_REASONS.has(String(reason || '').trim());
}

function normalizeBlock(control) {
  if (!control || typeof control !== 'object') return null;
  const reason = cleanText(control.reason, 80) || 'human_block';
  const blockedAt = cleanText(control.blockedAt, 80) || nowIso();
  const blockedUntil = isPersistentReason(reason) ? null : cleanText(control.blockedUntil, 80);
  const untilTimestamp = toFiniteTimestamp(blockedUntil);
  if (blockedUntil && untilTimestamp && untilTimestamp <= Date.now()) return null;

  return {
    reason,
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
    if (JSON.stringify(state.blocks[clientId]) !== JSON.stringify(normalized)) changed = true;
    state.blocks[clientId] = normalized;
  }
  if (changed && write) persist();
  return changed;
}

function getBlock(clientId) {
  for (const id of candidateBlockIds(clientId)) {
    const current = state.blocks[id];
    const normalized = normalizeBlock(current);
    if (!normalized) {
      if (current) {
        delete state.blocks[id];
        persist();
      }
      continue;
    }
    if (JSON.stringify(current) !== JSON.stringify(normalized)) {
      state.blocks[id] = normalized;
      persist();
    }
    return { blocked: true, control: normalized, blockId: id };
  }
  return { blocked: false, control: null, blockId: null };
}

function setBlock(clientId, payload = {}) {
  const ids = candidateBlockIds(clientId);
  if (!ids.length) return null;

  const blockedAt = payload.blockedAt || nowIso();
  const persistent = payload.persistent === true || isPersistentReason(payload.reason);
  const blockedUntil = persistent
    ? null
    : (payload.blockedUntil || addHoursIso(blockedAt, payload.blockedHours || env.humanBlockHours));

  const normalized = normalizeBlock({
    reason: payload.reason || 'human_block',
    source: payload.source || 'manual',
    seller: payload.seller || null,
    labelName: payload.labelName || null,
    blockedAt,
    blockedUntil,
  });

  for (const id of ids) state.blocks[id] = normalized;
  persist();
  return normalized;
}

function clearBlock(clientId) {
  let changed = false;
  for (const id of candidateBlockIds(clientId)) {
    if (!state.blocks[id]) continue;
    delete state.blocks[id];
    changed = true;
  }
  if (changed) persist();
  return changed;
}

function resetAll() {
  state.blocks = {};
  persist();
}

purgeExpiredBlocks({ write: false });

module.exports = {
  normalizeClientId,
  candidateBlockIds,
  getBlock,
  setBlock,
  clearBlock,
  purgeExpiredBlocks,
  resetAll,
  _test: {
    addHoursIso,
    cleanText,
    isPersistentReason,
    normalizeBlock,
  },
};
