'use strict';

const path = require('path');
const {
  decision,
  decisionError,
  incrementMetric,
  textPreview,
} = require('./decisionLogger');

function resultConfirmed(result) {
  return result !== false && result !== null;
}

function wrapAsyncMethod(target, methodName, describe) {
  if (!target || typeof target[methodName] !== 'function') return false;
  const marker = `__decisionWrapped_${methodName}`;
  if (target[marker]) return false;

  const original = target[methodName].bind(target);
  target[methodName] = async (...args) => {
    const details = typeof describe === 'function' ? describe(args) : {};
    const startedAt = Date.now();
    decision(details.category || 'ENVIO', details.event || 'tentativa', details.fields || {});

    try {
      const result = await original(...args);
      if (details.metric) incrementMetric(details.metric);
      decision(details.category || 'ENVIO', details.successEvent || 'concluído', {
        ...(details.fields || {}),
        confirmado: resultConfirmed(result),
        duração: `${Date.now() - startedAt}ms`,
      });
      return result;
    } catch (error) {
      decisionError(details.errorEvent || 'falha', error, {
        ...(details.fields || {}),
        operação: methodName,
        duração: `${Date.now() - startedAt}ms`,
      });
      throw error;
    }
  };
  target[marker] = true;
  return true;
}

function installDecisionChannelInstrumentation(channel) {
  if (!channel || channel.__decisionChannelInstrumentationInstalled) return channel;

  wrapAsyncMethod(channel, 'sendText', ([clientId, text]) => ({
    category: 'ENVIO',
    event: 'tentativa',
    successEvent: 'concluído',
    errorEvent: 'envio_falhou',
    metric: 'outbound',
    fields: { chat: clientId, tipo: 'texto', texto: textPreview(text) },
  }));

  wrapAsyncMethod(channel, 'sendImage', ([clientId, filePath, caption]) => ({
    category: 'ENVIO',
    event: 'tentativa',
    successEvent: 'concluído',
    errorEvent: 'envio_falhou',
    metric: 'outbound',
    fields: {
      chat: clientId,
      tipo: 'imagem',
      arquivo: filePath ? path.basename(String(filePath)) : '-',
      texto: textPreview(caption),
    },
  }));

  wrapAsyncMethod(channel, 'sendDocument', ([clientId, filePath, fileName, caption]) => ({
    category: 'ENVIO',
    event: 'tentativa',
    successEvent: 'concluído',
    errorEvent: 'envio_falhou',
    metric: 'outbound',
    fields: {
      chat: clientId,
      tipo: 'documento',
      arquivo: fileName || (filePath ? path.basename(String(filePath)) : '-'),
      texto: textPreview(caption),
    },
  }));

  wrapAsyncMethod(channel, 'sendCatalog', ([clientId, payload]) => ({
    category: 'ENVIO',
    event: 'tentativa',
    successEvent: 'concluído',
    errorEvent: 'envio_falhou',
    metric: 'outbound',
    fields: { chat: clientId, tipo: 'catálogo', título: payload?.title || payload?.name || '-' },
  }));

  wrapAsyncMethod(channel, 'setContactNote', ([clientId, note]) => ({
    category: 'NOTA',
    event: 'salvar',
    successEvent: 'salva',
    errorEvent: 'nota_falhou',
    metric: 'notes',
    fields: { chat: clientId, tamanho: String(note || '').length },
  }));

  wrapAsyncMethod(channel, 'applyContactLabel', ([clientId, label]) => ({
    category: 'ETIQUETA',
    event: 'aplicar',
    successEvent: 'aplicada',
    errorEvent: 'etiqueta_falhou',
    metric: 'labels',
    fields: { chat: clientId, etiqueta: label?.name || label || '-', cor: label?.color || '-' },
  }));

  wrapAsyncMethod(channel, 'markUnread', ([clientId]) => ({
    category: 'RECUPERAÇÃO',
    event: 'marcar_não_lida',
    successEvent: 'marcada_não_lida',
    errorEvent: 'marcar_não_lida_falhou',
    fields: { chat: clientId },
  }));

  wrapAsyncMethod(channel.client, 'sendListMessage', ([chatId, payload]) => ({
    category: 'ENVIO',
    event: 'tentativa',
    successEvent: 'concluído',
    errorEvent: 'envio_falhou',
    metric: 'outbound',
    fields: {
      chat: chatId,
      tipo: 'lista',
      título: payload?.title || '-',
      quantidade: (payload?.sections || []).reduce((sum, section) => sum + (section?.rows?.length || 0), 0),
    },
  }));

  wrapAsyncMethod(channel.client, 'sendList', ([chatId, description, buttonText, sections]) => ({
    category: 'ENVIO',
    event: 'tentativa',
    successEvent: 'concluído',
    errorEvent: 'envio_falhou',
    metric: 'outbound',
    fields: {
      chat: chatId,
      tipo: 'lista',
      título: buttonText || '-',
      texto: textPreview(description),
      quantidade: (sections || []).reduce((sum, section) => sum + (section?.rows?.length || 0), 0),
    },
  }));

  channel.__decisionChannelInstrumentationInstalled = true;
  decision('SISTEMA', 'instrumentação_de_envio_instalada', { status: 'ativa' });
  return channel;
}

module.exports = {
  installDecisionChannelInstrumentation,
  resultConfirmed,
  wrapAsyncMethod,
};
