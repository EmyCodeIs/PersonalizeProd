'use strict';

const WppClient = require('../services/wppconnectClient');
const SellerHandoff = require('./sellerHandoff');

function normalizeChatId(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/@(c\.us|g\.us|lid)$/i.test(raw)) return raw;
  const digits = raw.replace(/\D/g, '');
  return digits ? `${digits}@c.us` : raw;
}

function messageId(message = {}) {
  const candidates = [
    message?.id?._serialized,
    typeof message?.id === 'string' ? message.id : '',
    message?.messageId,
    message?.key?.id,
  ];
  return String(candidates.find((value) => typeof value === 'string' && value.trim()) || '').trim();
}

function outgoingChatId(message = {}) {
  return normalizeChatId(
    message?.to
    || message?.chatId
    || message?.id?.remote
    || message?.key?.remoteJid
    || message?.from
    || ''
  );
}

function firstVisibleString(...values) {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const text = value.trim();
    if (text) return text;
  }
  return '';
}

function outgoingText(message = {}) {
  return firstVisibleString(
    message?.body,
    message?.caption,
    message?.text,
    message?.description,
  );
}

function outgoingType(message = {}) {
  return String(
    message?.type
    || message?.mimetype
    || message?.mediaType
    || ''
  ).trim().toLowerCase();
}

function mediaMarker(message = {}) {
  const type = outgoingType(message);
  const filename = message?.filename || message?.fileName || message?.document?.filename || '';
  if (/image/.test(type)) return '[imagem enviada]';
  if (/document|pdf|application/.test(type) || filename) {
    return `[arquivo enviado${filename ? `: ${filename}` : ''}]`;
  }
  if (/video/.test(type)) return '[vídeo enviado]';
  if (/audio|ptt/.test(type)) return '[áudio enviado]';
  if (/sticker/.test(type)) return '[figurinha enviada]';
  return '';
}

function isVisibleOutgoingEvent(message = {}, text = '') {
  const type = outgoingType(message);
  const visibleType = /^(?:chat|text|image|video|document|audio|ptt|sticker|list|buttons?|template|location|vcard)$/;
  if (!visibleType.test(type)) return false;
  if (/^(?:chat|text)$/.test(type)) return Boolean(String(text || '').trim());
  return true;
}

function createDeduplicatedOutgoingHandler(handler, isInternalLabelOperation = () => false) {
  const seen = new Map();
  const ttlMs = 30000;

  return async function handleOutgoing(payload = {}) {
    if (typeof handler !== 'function') return;

    const raw = payload.raw || {};
    const chatId = normalizeChatId(payload.from || outgoingChatId(raw));
    if (!chatId || /@g\.us$/i.test(chatId)) return;

    if (isInternalLabelOperation(chatId)) {
      console.log(`[ETIQUETAS] evento interno ignorado durante aplicação: ${chatId}`);
      return;
    }

    const id = messageId(raw);
    const text = firstVisibleString(payload.text, outgoingText(raw), mediaMarker(raw));
    const type = outgoingType(raw) || 'unknown';

    if (!isVisibleOutgoingEvent(raw, text)) {
      console.log(`[EVENTO INTERNO] saída não-mensagem ignorada: ${chatId} | tipo=${type}`);
      return;
    }

    const now = Date.now();
    for (const [key, createdAt] of seen.entries()) {
      if ((now - createdAt) > ttlMs) seen.delete(key);
    }

    const fallbackWindow = Math.floor(now / 5000);
    const key = id
      ? `id:${id}`
      : `fallback:${chatId}:${type}:${text.toLowerCase()}:${fallbackWindow}`;

    if (seen.has(key)) {
      console.log(`[MONITOR DE SAÍDA] evento duplicado ignorado: ${chatId} | chave=${key}`);
      return;
    }

    seen.set(key, now);

    const matchedBotMessage = payload.channel?.outboundTracker?.consumeIfBot?.(chatId, raw);
    if (matchedBotMessage) {
      console.log(`[SAÍDA DO BOT] reconhecida: ${chatId} | tipo=${matchedBotMessage.type}`);
      return;
    }

    await handler({ ...payload, from: chatId, text, raw });
  };
}

const originalGetAutomationBlock = SellerHandoff.getAutomationBlock;
const originalCreateWppChannel = WppClient.createWppChannel;

WppClient.createWppChannel = async function createWppChannelWithReliableOutgoing(options = {}) {
  const internalLabelOperations = new Map();
  const labelGuardMs = 8000;

  const purgeLabelOperations = () => {
    const now = Date.now();
    for (const [chatId, expiresAt] of internalLabelOperations.entries()) {
      if (expiresAt <= now) internalLabelOperations.delete(chatId);
    }
  };

  const isInternalLabelOperation = (chatId) => {
    purgeLabelOperations();
    return Number(internalLabelOperations.get(normalizeChatId(chatId)) || 0) > Date.now();
  };

  const markInternalLabelOperation = (chatId) => {
    const normalized = normalizeChatId(chatId);
    if (!normalized) return;
    internalLabelOperations.set(normalized, Date.now() + labelGuardMs);
  };

  const handleOutgoing = createDeduplicatedOutgoingHandler(
    options.onOutgoingMessage,
    isInternalLabelOperation,
  );

  const channel = await originalCreateWppChannel({
    ...options,
    onOutgoingMessage: handleOutgoing,
  });

  if (typeof channel?.applyContactLabel === 'function') {
    const originalApplyContactLabel = channel.applyContactLabel.bind(channel);
    channel.applyContactLabel = async (clientId, label = {}) => {
      markInternalLabelOperation(clientId);
      console.log(
        `[ETIQUETAS] proteção de operação interna ativada: ${normalizeChatId(clientId)} `
        + `| etiqueta=${String(label?.name || label || '-').trim() || '-'}`,
      );
      try {
        return await originalApplyContactLabel(clientId, label);
      } finally {
        markInternalLabelOperation(clientId);
      }
    };
  }

  channel.__markInternalLabelOperation = markInternalLabelOperation;
  channel.__isInternalLabelOperation = isInternalLabelOperation;

  const client = channel?.client;
  if (typeof client?.onAnyMessage === 'function') {
    client.onAnyMessage(async (message) => {
      if (!message?.fromMe || message?.isGroupMsg) return;
      const from = outgoingChatId(message);
      if (!from) return;
      const text = outgoingText(message) || mediaMarker(message);
      await handleOutgoing({
        from,
        text,
        raw: message,
        channel,
        source: 'onAnyMessage',
      });
    });
    console.log('[MONITOR DE SAÍDA] mensagens manuais e saídas do bot monitoradas com deduplicação');
  } else {
    console.warn('[MONITOR DE SAÍDA] onAnyMessage indisponível; mensagens manuais monitoradas somente por onMessage');
  }

  return channel;
};

module.exports = {
  _test: {
    createDeduplicatedOutgoingHandler,
    firstVisibleString,
    isVisibleOutgoingEvent,
    mediaMarker,
    messageId,
    normalizeChatId,
    outgoingChatId,
    outgoingText,
    outgoingType,
    originalGetAutomationBlock,
  },
};
