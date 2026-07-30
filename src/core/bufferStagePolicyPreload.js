'use strict';

const { BufferManager } = require('./bufferManager');
const Store = require('../services/leadStore');
const { env } = require('../config/env');

if (!BufferManager.prototype.__stagePolicyInstalled) {
  const originalPush = BufferManager.prototype.push;

  BufferManager.prototype.push = function pushWithStagePolicy(clientId, message, options = {}) {
    const stage = String(Store.getSession(clientId)?.etapa || '').trim();
    const requestedDelay = Number(options.delayMs);
    let delayMs = options.delayMs;

    if (stage === 'inicio') {
      delayMs = env.firstInputBufferMs;
    } else if (stage === 'suporte_coleta') {
      delayMs = env.supportBufferMs;
    } else if (stage === 'plotagem_cidade' || stage === 'outros_cidade') {
      delayMs = env.cityBufferMs;
    } else if (stage === 'plotagem_observacao_coleta' || stage === 'outros_observacao_coleta') {
      delayMs = env.observationBufferMs;
    }

    if (Number.isFinite(Number(delayMs)) && Number(delayMs) !== requestedDelay) {
      console.log(`[BUFFER] espera efetiva ajustada | cliente=${clientId} | etapa=${stage || '-'} | espera=${Number(delayMs)}ms`);
    }

    return originalPush.call(this, clientId, message, { ...options, delayMs });
  };

  BufferManager.prototype.__stagePolicyInstalled = true;
}

console.log(`[BUFFER] política adicional ativa | primeiroInput=${env.firstInputBufferMs}ms | suporte=${env.supportBufferMs}ms | cidade=${env.cityBufferMs}ms | observação=${env.observationBufferMs}ms`);

module.exports = {};