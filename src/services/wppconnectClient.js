'use strict';

const path = require('path');
const { env } = require('../config/env');
const { applyNamedLabel } = require('../core/serviceLabels');
const { OutboundTracker } = require('../core/outboundTracker');
const { resolveBrowserArgs, resolveBrowserExecutable } = require('../core/vpsBrowserPreload');
const { publishConnected, publishQrCode, publishState } = require('./qrAccess');
const { setQrAdminClient } = require('./qrAdminServer');

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms || 0))));
}

function randomDelay() {
  const min = env.minReplyDelayMs;
  const max = env.maxReplyDelayMs;
  return min + Math.floor(Math.random() * Math.max(1, max - min + 1));
}

function normalizeChatId(clientId) {
  const raw = String(clientId || '').trim();
  if (!raw) return '';
  if (/@(c\.us|g\.us|lid)$/i.test(raw)) return raw;
  const digits = raw.replace(/\D/g, '');
  return digits ? `${digits}@c.us` : raw;
}

function getInteractiveId(message = {}) {
  const candidates = [
    message?.selectedRowId,
    message?.selectedButtonId,
    message?.listResponse?.singleSelectReply?.selectedRowId,
    message?.listResponseMessage?.singleSelectReply?.selectedRowId,
    message?.buttonsResponseMessage?.selectedButtonId,
    message?.templateButtonReplyMessage?.selectedId,
    message?.interactive?.list_reply?.id,
    message?.interactive?.button_reply?.id,
  ];
  for (const candidate of candidates) {
    const value = String(candidate || '').trim();
    if (value) return value;
  }
  return '';
}

function getMessageText(message) {
  const interactiveId = getInteractiveId(message);
  if (interactiveId) return interactiveId;
  return String(message?.body || message?.caption || message?.text || message?.content || '').trim();
}

function getMediaMarker(message = {}) {
  const type = String(message?.type || message?.mimetype || message?.mediaType || '').toLowerCase();
  const filename = message?.filename || message?.fileName || message?.document?.filename || '';
  if (/image/.test(type)) return '[imagem enviada]';
  if (/document|pdf|application/.test(type) || filename) return `[arquivo enviado${filename ? `: ${filename}` : ''}]`;
  if (/video/.test(type)) return '[vídeo enviado]';
  return '';
}

function getMessageFrom(message, fallbackChatId = '') {
  return String(message?.from || message?.chatId || message?.sender?.id || fallbackChatId || '').trim();
}

function getOutgoingChatId(message, fallbackChatId = '') {
  return normalizeChatId(
    message?.to
    || message?.chatId
    || message?.id?.remote
    || message?.key?.remoteJid
    || message?.from
    || fallbackChatId
    || ''
  );
}

function normalizeUnreadMessage(message, fallbackChatId = '') {
  const from = getMessageFrom(message, fallbackChatId);
  const text = getMessageText(message) || getMediaMarker(message);
  if (!from || !text || message?.fromMe) return null;
  if (message?.isGroupMsg || /@g\.us$/i.test(from)) return null;
  return { from, text, raw: message };
}

function registerOutbound(channel, clientId, payload = {}) {
  return channel?.outboundTracker?.register?.(clientId, payload) || null;
}

function confirmOutbound(channel, pending, result) {
  channel?.outboundTracker?.confirm?.(pending, result);
}

function failOutbound(channel, pending) {
  channel?.outboundTracker?.fail?.(pending);
}

function createMockChannel() {
  const tracker = new OutboundTracker();
  const client = {
    async sendText(chatId, text) {
      console.log(`\n[BOT -> ${chatId}] ${text}\n`);
      return true;
    },
    async sendImage(chatId, filePath, fileName, caption = '') {
      console.log(`\n[IMAGEM -> ${chatId}] ${fileName || path.basename(filePath)}\n${caption}\n`);
      return true;
    },
    async sendListMessage(chatId, payload) {
      console.log(`\n[LISTA -> ${chatId}] ${payload?.description || ''}`);
      for (const section of payload?.sections || []) {
        console.log(`[${section.title}]`);
        for (const row of section.rows || []) console.log(`- ${row.id}: ${row.title}`);
      }
      return true;
    },
    async startTyping() { return true; },
    async stopTyping() { return true; },
  };

  return {
    client,
    outboundTracker: tracker,
    async sendText(clientId, text) { return client.sendText(normalizeChatId(clientId), text); },
    async sendImage(clientId, filePath, caption = '') {
      const fullPath = path.resolve(process.cwd(), filePath);
      return client.sendImage(normalizeChatId(clientId), fullPath, path.basename(fullPath), caption);
    },
    async sendDocument(clientId, filePath, fileName, caption = '') {
      console.log(`\n[DOCUMENTO BLOQUEADO/TESTE -> ${clientId}] ${fileName || path.basename(filePath)}\n${caption}\n`);
      return true;
    },
    async setContactNote(clientId, note) {
      console.log(`\n[NOTA ${clientId}]\n${note}\n`);
      return true;
    },
    async applyContactLabel(clientId, label) {
      console.log(`\n[ETIQUETA ${clientId}] ${label?.name || label} (${label?.color || 'green'})\n`);
      return true;
    },
    async markUnread(clientId) {
      console.log(`\n[MARCAR NÃO LIDO ${clientId}]\n`);
      return true;
    },
  };
}

async function collectViaUnreadMethods(client) {
  for (const name of ['getUnreadMessages', 'getAllUnreadMessages']) {
    if (typeof client?.[name] !== 'function') continue;
    try {
      const result = await client[name]();
      const list = Array.isArray(result) ? result : Object.values(result || {});
      const normalized = list.map((msg) => normalizeUnreadMessage(msg)).filter(Boolean);
      if (normalized.length) return normalized;
    } catch (err) {
      console.warn(`[WPPConnect] ${name} falhou:`, err?.message || err);
    }
  }
  return [];
}

async function listChatsCompat(client) {
  if (typeof client?.listChats === 'function') return client.listChats();
  if (typeof client?.getAllChats === 'function') return client.getAllChats();
  if (typeof client?.getAllChatsWithMessages === 'function') return client.getAllChatsWithMessages();
  return [];
}

async function collectViaChats(client) {
  let chats = [];
  try {
    const result = await listChatsCompat(client);
    chats = Array.isArray(result) ? result : Object.values(result || {});
  } catch (err) {
    console.warn('[WPPConnect] não foi possível listar chats:', err?.message || err);
    return [];
  }

  const chatList = chats
    .filter((chat) => !chat?.isGroup && !chat?.isGroupMsg && !/@g\.us$/i.test(String(chat?.id?._serialized || chat?.id || '')))
    .filter((chat) => Number(chat?.unreadCount || chat?.unread || chat?.unreadMessages || 0) > 0)
    .slice(0, env.unreadBootstrapMaxChats);

  const output = [];
  for (const chat of chatList) {
    const chatId = String(chat?.id?._serialized || chat?.id || chat?.contact?.id?._serialized || '').trim();
    const unreadCount = Number(chat?.unreadCount || chat?.unread || chat?.unreadMessages || 0) || env.unreadBootstrapMaxMessagesPerChat;
    const limit = Math.min(env.unreadBootstrapMaxMessagesPerChat, unreadCount);
    let messages = Array.isArray(chat?.msgs) ? chat.msgs : Array.isArray(chat?.messages) ? chat.messages : [];
    if (!messages.length && chatId && typeof client?.getAllMessagesInChat === 'function') {
      try { messages = await client.getAllMessagesInChat(chatId, true, false); } catch (_) {}
    }
    for (const message of (Array.isArray(messages) ? messages : Object.values(messages || {})).slice(-limit)) {
      const normalized = normalizeUnreadMessage(message, chatId);
      if (normalized) output.push(normalized);
    }
  }
  return output;
}

async function collectUnreadMessages(client) {
  const all = [];
  for (const collect of [collectViaUnreadMethods, collectViaChats]) {
    const found = await collect(client);
    all.push(...found);
    if (all.length) break;
  }
  const seen = new Set();
  return all.filter((item) => {
    const key = item?.raw?.id?._serialized || item?.raw?.id || `${item.from}:${item.text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function createWppChannel({ onMessage, onOutgoingMessage, onQr } = {}) {
  const wppconnect = require('@wppconnect-team/wppconnect');
  const browserArgs = resolveBrowserArgs();
  const browserExecutable = resolveBrowserExecutable({ configured: env.wppExecutablePath });
  if (env.wppRequireSystemBrowser && !browserExecutable) {
    const error = new Error('Google Chrome/Chromium do sistema não foi encontrado.');
    error.code = 'WPP_SYSTEM_BROWSER_NOT_FOUND';
    throw error;
  }
  console.log(`[WPPConnect] Chrome visível: ${env.wppHeadless ? 'não (headless)' : 'sim'}`);
  if (browserExecutable) console.log(`[VPS-CHROME] executável: ${browserExecutable}`);
  if (browserArgs.length) {
    console.log(`[VPS-CHROME] argumentos aplicados: ${browserArgs.join(' ')}`);
  }

  const client = await wppconnect.create({
    session: env.sessionName,
    catchQR: (base64Qr, asciiQR, attempts, urlCode) => {
      console.log('\n[WPPConnect] Escaneie o QR Code com o WhatsApp Business.\n');
      console.log(asciiQR);
      publishQrCode({ base64Qr, attempts, urlCode, connectionState: 'PAIRING' });
      if (typeof onQr === 'function') onQr({ base64Qr, asciiQR, attempts, urlCode });
    },
    statusFind: (statusSession, session) => {
      console.log('[WPPConnect]', session, statusSession);
      publishState(String(statusSession || '').trim().toUpperCase(), `Status do WPPConnect: ${statusSession}`);
    },
    headless: env.wppHeadless,
    useChrome: true,
    browserArgs,
    puppeteerOptions: browserExecutable ? { executablePath: browserExecutable } : undefined,
    // Keep the shared Chrome open indefinitely on the VPS so the remote view
    // always shows the same WhatsApp Web session until the user scans the QR.
    autoClose: 0,
    deviceSyncTimeout: 0,
    waitForLogin: false,
    folderNameToken: 'tokens',
  });

  const tracker = new OutboundTracker();
  setQrAdminClient(client);
  const channel = {
    client,
    outboundTracker: tracker,
    async sendText(clientId, text, options = {}) {
      const chatId = normalizeChatId(clientId);
      if (!options.noDelay) await wait(randomDelay());
      const pending = registerOutbound(channel, chatId, { type: 'text', text });
      try {
        const result = await client.sendText(chatId, String(text || ''));
        confirmOutbound(channel, pending, result);
        return result;
      } catch (err) {
        failOutbound(channel, pending);
        throw err;
      }
    },
    async sendImage(clientId, filePath, caption = '', options = {}) {
      const chatId = normalizeChatId(clientId);
      const fullPath = path.resolve(process.cwd(), filePath);
      if (!options.noDelay) await wait(randomDelay());
      if (typeof client.sendImage !== 'function') return false;
      const pending = registerOutbound(channel, chatId, {
        type: 'image',
        text: caption,
        filename: path.basename(fullPath),
      });
      try {
        const result = await client.sendImage(chatId, fullPath, path.basename(fullPath), String(caption || ''));
        confirmOutbound(channel, pending, result);
        return result;
      } catch (err) {
        failOutbound(channel, pending);
        throw err;
      }
    },
    async sendDocument(clientId, filePath, fileName, caption = '', options = {}) {
      const chatId = normalizeChatId(clientId);
      const fullPath = path.resolve(process.cwd(), filePath);
      if (!options.noDelay) await wait(randomDelay());
      if (typeof client.sendFile !== 'function') return false;
      const pending = registerOutbound(channel, chatId, {
        type: 'document',
        text: caption,
        filename: fileName || path.basename(fullPath),
      });
      try {
        const result = await client.sendFile(chatId, fullPath, fileName || path.basename(fullPath), String(caption || ''));
        confirmOutbound(channel, pending, result);
        return result;
      } catch (err) {
        failOutbound(channel, pending);
        throw err;
      }
    },
    async setContactNote(clientId, note) {
      const chatId = normalizeChatId(clientId);
      try {
        if (!client?.page?.evaluate) return false;
        return await client.page.evaluate(async ({ chatId, note }) => {
          if (window.WPP?.chat?.setNotes) return window.WPP.chat.setNotes(chatId, note);
          if (window.WPP?.contact?.setNotes) return window.WPP.contact.setNotes(chatId, note);
          return false;
        }, { chatId, note });
      } catch (err) {
        console.warn('[WPPConnect] não foi possível salvar nota:', err?.message || err);
        return false;
      }
    },
    async markUnread(clientId) {
      const chatId = normalizeChatId(clientId);
      const attempts = [
        async () => typeof client?.markUnseenMessage === 'function' && (await client.markUnseenMessage(chatId), true),
        async () => typeof client?.markUnread === 'function' && (await client.markUnread(chatId), true),
      ];
      for (const attempt of attempts) {
        try { if (await attempt()) return true; } catch (_) {}
      }
      return false;
    },
    async applyContactLabel(clientId, label = {}) {
      const target = {
        name: String(label.name || env.awaitingQuoteLabelName || 'Aguardando orçamento').trim(),
        color: String(label.color || env.awaitingQuoteLabelColor || 'gray').trim(),
      };
      const result = await applyNamedLabel({ client }, clientId, target);
      return result === true || result?.applied === true;
    },
  };

  client.onStateChange((state) => {
    console.log('[WPPConnect] estado:', state);
    const normalized = String(state || '').trim().replace(/[\s-]+/g, '_').toUpperCase();
    if (normalized === 'CONNECTED' || normalized === 'INCHAT') {
      publishConnected(normalized);
      return;
    }
    publishState(normalized);
  });
  client.onMessage(async (message) => {
    if (message?.isGroupMsg) return;

    if (message?.fromMe) {
      const to = getOutgoingChatId(message);
      const text = getMessageText(message) || getMediaMarker(message);
      if (!to) return;
      await onOutgoingMessage?.({ from: to, text, raw: message, channel });
      return;
    }

    const from = String(message?.from || message?.chatId || '').trim();
    const text = getMessageText(message) || getMediaMarker(message);
    if (!from || !text) return;
    console.log(`[WPPConnect] mensagem recebida de ${from}`);
    await onMessage?.({ from, text, raw: message, channel });
  });

  return channel;
}

module.exports = {
  createWppChannel,
  createMockChannel,
  normalizeChatId,
  collectUnreadMessages,
  getInteractiveId,
  getMessageText,
};