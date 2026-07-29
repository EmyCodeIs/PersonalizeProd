'use strict';

const { AsyncLocalStorage } = require('async_hooks');
const BotActivity = require('../services/botActivityStore');
const HumanControl = require('../services/humanControlStore');
const ResetStore = require('../services/handoffResetStore');
const Access = require('./testCommandAccess');
const { decision } = require('./decisionLogger');
const { isStrictTesterIdentity } = require('./handoffPolicy');

const historyContext = new AsyncLocalStorage();
const STARTUP_BOUNDARY_AT = new Date().toISOString();

function timestamp(value) {
  const parsed = new Date(value || 0).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function newestCheckpoint(...values) {
  return values
    .filter(Boolean)
    .sort((left, right) => timestamp(right.at) - timestamp(left.at))[0] || null;
}

function withHandoffHistoryBoundary(action) {
  if (typeof action !== 'function') return null;
  return historyContext.run({ handoffHistoryBoundary: true }, action);
}

function installStrictTesterIdentity() {
  Access.isTesterIdentity = function isTesterIdentityStrict(payload = {}) {
    return isStrictTesterIdentity(payload);
  };
}

function installContextualHistoryBoundary() {
  if (BotActivity.__contextualHandoffBoundaryInstalled) return;
  const originalGetLastBotOutbound = BotActivity.getLastBotOutbound.bind(BotActivity);

  BotActivity.getLastBotOutbound = function getContextualBotCheckpoint(clientId) {
    const actual = originalGetLastBotOutbound(clientId);
    if (!historyContext.getStore()?.handoffHistoryBoundary) return actual;

    const reset = ResetStore.getResetCheckpoint(clientId);
    const resetBoundary = reset ? {
      at: reset.at,
      messageId: null,
      type: 'resetarsys_handoff_boundary',
      synthetic: true,
    } : null;
    const knownBoundary = newestCheckpoint(actual, resetBoundary);
    if (knownBoundary) return knownBoundary;

    return {
      at: STARTUP_BOUNDARY_AT,
      messageId: null,
      type: 'startup_handoff_boundary',
      synthetic: true,
    };
  };

  BotActivity.__contextualHandoffBoundaryInstalled = true;
}

function installTesterBlockProtection() {
  if (HumanControl.__strictTesterBlockProtectionInstalled) return;
  const originalSetBlock = HumanControl.setBlock.bind(HumanControl);

  HumanControl.setBlock = function setBlockExceptTester(clientId, payload = {}) {
    if (isStrictTesterIdentity({ from: clientId })) {
      try { HumanControl.clearBlock(clientId); } catch (_) {}
      decision('HANDOFF', 'bloqueio_ignorado_para_tester', {
        chat: clientId,
        status: 'livre',
        motivo: payload?.reason || 'handoff_candidate',
      });
      return {
        bypassed: true,
        reason: 'tester_identity',
        blockedUntil: null,
      };
    }
    return originalSetBlock(clientId, payload);
  };

  HumanControl.__strictTesterBlockProtectionInstalled = true;
}

installStrictTesterIdentity();
installContextualHistoryBoundary();
installTesterBlockProtection();

module.exports = {
  STARTUP_BOUNDARY_AT,
  installContextualHistoryBoundary,
  installStrictTesterIdentity,
  installTesterBlockProtection,
  newestCheckpoint,
  withHandoffHistoryBoundary,
};
