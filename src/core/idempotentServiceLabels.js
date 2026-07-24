'use strict';

const ServiceLabels = require('./serviceLabels');
const Identity = require('../services/contactIdentity');

const confirmed = new Set();
const inFlight = new Map();

function normalizedContactKey(clientId) {
  try {
    return String(Identity.getSessionKey(clientId) || Identity.normalizeChatId(clientId) || clientId || '').trim();
  } catch (_) {
    return String(clientId || '').trim();
  }
}

function operationKey(clientId, service) {
  return `${normalizedContactKey(clientId)}:${String(service || '').trim().toLowerCase()}`;
}

function isApplied(result) {
  return result === true || result?.applied === true;
}

function clearServiceLabelCache(clientId = '') {
  const contactKey = normalizedContactKey(clientId);
  if (!contactKey) {
    confirmed.clear();
    inFlight.clear();
    return;
  }

  const prefix = `${contactKey}:`;
  for (const key of confirmed) {
    if (key.startsWith(prefix)) confirmed.delete(key);
  }
  for (const key of inFlight.keys()) {
    if (key.startsWith(prefix)) inFlight.delete(key);
  }
}

function installIdempotentServiceLabels() {
  if (ServiceLabels.__idempotentServiceLabelsInstalled) return ServiceLabels;

  const originalReplaceServiceLabel = ServiceLabels.replaceServiceLabel.bind(ServiceLabels);

  ServiceLabels.replaceServiceLabel = async function replaceServiceLabelOnce(channel, clientId, service) {
    const key = operationKey(clientId, service);
    if (!key || key.startsWith(':')) return originalReplaceServiceLabel(channel, clientId, service);

    if (confirmed.has(key)) {
      console.log(`[LISTAS] etiqueta já confirmada; reaplicação ignorada | contato=${normalizedContactKey(clientId)} | serviço=${service}`);
      return {
        applied: true,
        verified: true,
        alreadyAttached: true,
        mode: 'idempotent-cache',
      };
    }

    if (inFlight.has(key)) return inFlight.get(key);

    const task = (async () => {
      const result = await originalReplaceServiceLabel(channel, clientId, service);
      if (isApplied(result)) confirmed.add(key);
      return result;
    })().finally(() => {
      inFlight.delete(key);
    });

    inFlight.set(key, task);
    return task;
  };

  ServiceLabels.__idempotentServiceLabelsInstalled = true;
  return ServiceLabels;
}

module.exports = {
  installIdempotentServiceLabels,
  clearServiceLabelCache,
  _test: {
    confirmed,
    inFlight,
    isApplied,
    operationKey,
  },
};
