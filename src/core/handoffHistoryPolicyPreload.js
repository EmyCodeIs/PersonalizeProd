'use strict';

const { AsyncLocalStorage } = require('async_hooks');
const BotActivity = require('../services/botActivityStore');
const ResetStore = require('../services/handoffResetStore');

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

    // Um checkpoint real do bot ou um /resetarsys persistente continua válido
    // depois de reinícios. O mais recente define de onde o histórico pode ser
    // considerado. Assim, mensagens humanas anteriores ao reset são ignoradas,
    // mas qualquer intervenção posterior volta a ativar handoff normalmente.
    const knownBoundary = newestCheckpoint(actual, resetBoundary);
    if (knownBoundary) return knownBoundary;

    // Apenas conversas sem qualquer checkpoint usam o início atual para não
    // inferir handoff a partir de um histórico antigo e sem contexto.
    return {
      at: STARTUP_BOUNDARY_AT,
      messageId: null,
      type: 'startup_handoff_boundary',
      synthetic: true,
    };
  };

  BotActivity.__contextualHandoffBoundaryInstalled = true;
}

installContextualHistoryBoundary();

module.exports = {
  STARTUP_BOUNDARY_AT,
  installContextualHistoryBoundary,
  newestCheckpoint,
  withHandoffHistoryBoundary,
};
