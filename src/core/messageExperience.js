'use strict';

const path = require('path');
const { AsyncLocalStorage } = require('async_hooks');
const { env } = require('../config/env');
const { sendBemVindos } = require('./mostruario');
const { shouldSuppressTyping } = require('./runtimeProtection');
const OutboundLedgerContext = require('./outboundLedgerContext');

const responseContext = new AsyncLocalStorage();

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms || 0))));
}

function normalizeChatId(clientId) {
  const raw = String(clientId || '').trim();
  if (!raw) return '';
  if (/@(c\.us|g\.us|lid)$/i.test(raw)) return raw;
  const digits = raw.replace(/\D/g, '');
  return digits ? `${digits}@c.us` : raw;
}

function typingDuration(text, options = {}) {
  const min = Math.max(0, Number(options.minMs ?? env.typingMinMs));
  const max = Math.max(min, Number(options.maxMs ?? env.typingMaxMs));
  const estimated = Math.round((String(text || '').length / env.typingCharsPerSecond) * 1000);
  return Math.max(min, Math.min(max, estimated || min));
}

async function startTypingCompat(client, chatId) {
  const attempts = [
    async () => {
      if (typeof client?.startTyping !== 'function') return false;
      await client.startTyping(chatId);
      return true;
    },
    async () => {
      if (typeof client?.setChatState !== 'function') return false;
      await client.setChatState(chatId, 0);
      return true;
    },
  ];
  for (const attempt of attempts) {
    try {
      if (await attempt()) return true;
    } catch (_) {}
  }
  return false;
}

async function stopTypingCompat(client, chatId) {
  const attempts = [
    async () => {
      if (typeof client?.stopTyping !== 'function') return false;
      await client.stopTyping(chatId);
      return true;
    },
    async () => {
      if (typeof client?.setChatState !== 'function') return false;
      await client.setChatState(chatId, 2);
      return true;
    },
  ];
  for (const attempt of attempts) {
    try {
      if (await attempt()) return true;
    } catch (_) {}
  }
  return false;
}

function currentResponseOptions() {
  return responseContext.getStore() || {};
}

function isGroupedResponse() {
  return !!currentResponseOptions().grouped;
}

function isWelcomeText(text) {
  return /bem-vindo\(a\) ao canal de atendimento da personalize!/i.test(String(text || ''));
}

function outboundTextAttempts() {
  const value = Number(process.env.OUTBOUND_TEXT_ATTEMPTS);
  return Number.isFinite(value) && value >= 1 ? Math.floor(value) : 2;
}

function outboundTextRetryMs() {
  const value = Number(process.env.OUTBOUND_TEXT_RETRY_MS);
  return Number.isFinite(value) && value >= 0 ? value : 700;
}

function ledgerOptionsForText(text, options = {}) {
  if (options.ledgerOperationKey) return { ...options };
  const operation = OutboundLedgerContext.nextOperation({
    type: 'text',
    text,
    source: options.ledgerSource || 'messageExperience.sendText',
  });
  return {
    ...options,
    ledgerOperationKey: operation.operationKey || undefined,
    ledgerSource: options.ledgerSource || operation.source || 'messageExperience.sendText',
  };
}

async function sendTextOnce(channel, clientId, text, options = {}) {
  if (typeof channel?.__rawSendText === 'function') {
    return channel.__rawSendText(clientId, text, { ...options, noDelay: true });
  }
  const chatId = normalizeChatId(clientId);
  if (typeof channel?.client?.sendText === 'function') {
    return channel.client.sendText(chatId, String(text || ''));
  }
  return channel?.sendText?.(clientId, text, { ...options, noDelay: true });
}

async function sendTextDirect(channel, clientId, text, options = {}) {
  const attempts = outboundTextAttempts();
  const retryMs = outboundTextRetryMs();
  const stableOptions = ledgerOptionsForText(text, options);
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const result = await sendTextOnce(channel, clientId, text, stableOptions);
      if (result !== false && result !== null) return result === undefined ? true : result;
      lastError = new Error('OUTBOUND_TEXT_NOT_CONFIRMED');
      console.warn(
        `[MENSAGEM] envio sem confirmação | cliente=${clientId} | tentativa=${attempt}/${attempts}`,
      );
    } catch (error) {
      lastError = error;
      console.warn(
        `[MENSAGEM] falha no envio | cliente=${clientId} | tentativa=${attempt}/${attempts} `
        + `| erro=${error?.message || error}`,
      );
    }

    if (attempt < attempts && retryMs) await wait(retryMs);
  }

  const error = new Error(
    `Não foi possível confirmar o envio da mensagem após ${attempts} tentativa(s): ${lastError?.message || 'erro desconhecido'}`,
  );
  error.code = 'outbound_text_unconfirmed';
  throw error;
}

async function sendTextWithLinkedWelcome(channel, clientId, text, options = {}) {
  const result = await sendTextDirect(channel, clientId, text, options);
  if (isWelcomeText(text) && !options.skipWelcomeMedia) {
    await sendBemVindos(channel, clientId);
  }
  return result;
}

async function sendImageDirect(channel, clientId, filePath, caption = '', options = {}) {
  if (typeof channel?.__rawSendImage === 'function') {
    return channel.__rawSendImage(clientId, filePath, caption, { ...options, noDelay: true });
  }
  const chatId = normalizeChatId(clientId);
  const fullPath = path.resolve(process.cwd(), filePath);
  if (typeof channel?.client?.sendImage === 'function') {
    return channel.client.sendImage(chatId, fullPath, path.basename(fullPath), String(caption || ''));
  }
  return channel?.sendImage?.(clientId, filePath, caption, { ...options, noDelay: true });
}

function installMessageExperience(channel) {
  if (!channel || channel.__messageExperienceInstalled) return channel;

  channel.__rawSendText = typeof channel.sendText === 'function' ? channel.sendText.bind(channel) : null;
  channel.__rawSendImage = typeof channel.sendImage === 'function' ? channel.sendImage.bind(channel) : null;

  if (channel.__rawSendText) {
    channel.sendText = async (clientId, text, options = {}) => {
      const grouped = currentResponseOptions();
      if (grouped.grouped || options.noTyping) {
        return sendTextWithLinkedWelcome(channel, clientId, text, options);
      }

      const chatId = normalizeChatId(clientId);
      const started = (env.enableTyping && !shouldSuppressTyping())
        ? await startTypingCompat(channel.client, chatId)
        : false;
      try {
        if (started) await wait(typingDuration(text, options));
        return await sendTextWithLinkedWelcome(channel, clientId, text, options);
      } finally {
        if (started) await stopTypingCompat(channel.client, chatId);
      }
    };
  }

  if (channel.__rawSendImage) {
    channel.sendImage = async (clientId, filePath, caption = '', options = {}) => {
      const grouped = currentResponseOptions();
      if (grouped.grouped || options.noTyping) {
        return sendImageDirect(channel, clientId, filePath, caption, options);
      }

      const chatId = normalizeChatId(clientId);
      const started = (env.enableTyping && !shouldSuppressTyping())
        ? await startTypingCompat(channel.client, chatId)
        : false;
      try {
        if (started) await wait(typingDuration(caption || 'Enviando imagem', options));
        return await sendImageDirect(channel, clientId, filePath, caption, options);
      } finally {
        if (started) await stopTypingCompat(channel.client, chatId);
      }
    };
  }

  channel.startTyping = async (clientId) => startTypingCompat(channel.client, normalizeChatId(clientId));
  channel.stopTyping = async (clientId) => stopTypingCompat(channel.client, normalizeChatId(clientId));

  channel.runResponseGroup = async (clientId, summaryText, action, options = {}) => {
    if (typeof action !== 'function') return null;
    if (isGroupedResponse()) return action();

    const chatId = normalizeChatId(clientId);
    const shouldType = env.enableTyping && !shouldSuppressTyping();
    const started = shouldType ? await startTypingCompat(channel.client, chatId) : false;

    try {
      if (started) await wait(typingDuration(summaryText || 'Preparando resposta', options));
      return await responseContext.run({
        grouped: true,
        clientId: chatId,
      }, action);
    } finally {
      if (started) await stopTypingCompat(channel.client, chatId);
    }
  };

  channel.__messageExperienceInstalled = true;
  return channel;
}

module.exports = {
  installMessageExperience,
  ledgerOptionsForText,
  outboundTextAttempts,
  outboundTextRetryMs,
  sendTextDirect,
  sendTextOnce,
  startTypingCompat,
  stopTypingCompat,
  typingDuration,
  isGroupedResponse,
  isWelcomeText,
};
