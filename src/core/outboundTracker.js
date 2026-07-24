'use strict';

function normalizeChatId(clientId) {
  const raw = String(clientId || '').trim();
  if (!raw) return '';
  if (/@(c\.us|g\.us|lid)$/i.test(raw)) return raw;
  const digits = raw.replace(/\D/g, '');
  return digits ? `${digits}@c.us` : raw;
}

function normalizeText(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function extractMessageId(message = {}) {
  return String(
    message?.id?._serialized
    || message?.id
    || message?.messageId
    || message?.key?.id
    || ''
  ).trim() || null;
}

function extractChatId(message = {}) {
  return normalizeChatId(
    message?.to
    || message?.chatId
    || message?.id?.remote
    || message?.key?.remoteJid
    || message?.from
    || ''
  );
}

function extractText(message = {}) {
  return normalizeText(
    message?.body
    || message?.caption
    || message?.text
    || message?.content
    || message?.description
    || ''
  );
}

function extractType(message = {}) {
  return String(
    message?.type
    || message?.mimetype
    || message?.mediaType
    || 'text'
  ).trim().toLowerCase() || 'text';
}

function extractFilename(message = {}) {
  return normalizeText(
    message?.filename
    || message?.fileName
    || message?.document?.filename
    || message?.document?.fileName
    || ''
  );
}

function isMediaType(type = '') {
  return /image|video|document|pdf|application|audio|ptt|sticker/.test(String(type || '').toLowerCase());
}

function looksLikeEncodedMedia(value = '') {
  const compact = String(value || '').replace(/\s+/g, '');
  if (compact.length < 256) return false;
  return /^(?:data:[^;]+;base64,)?[A-Za-z0-9+/]+={0,2}$/.test(compact);
}

class OutboundTracker {
  constructor({ ttlMs = 120000, recentMatchWindowMs = 30000 } = {}) {
    this.ttlMs = Math.max(10000, Number(ttlMs || 0));
    this.recentMatchWindowMs = Math.max(3000, Number(recentMatchWindowMs || 0));
    this.byChat = new Map();
    this.sequence = 0;
  }

  purge(chatId = '') {
    const now = Date.now();
    const chats = chatId ? [normalizeChatId(chatId)] : [...this.byChat.keys()];

    for (const id of chats) {
      const list = this.byChat.get(id) || [];
      const active = list.filter((item) => {
        if (!item || item.consumed) return false;
        return (now - item.createdAt) <= this.ttlMs;
      });
      if (active.length) this.byChat.set(id, active);
      else this.byChat.delete(id);
    }
  }

  register(chatId, payload = {}) {
    const id = normalizeChatId(chatId);
    if (!id) return null;

    const item = {
      token: `out_${Date.now()}_${++this.sequence}`,
      chatId: id,
      type: String(payload.type || 'text').trim().toLowerCase() || 'text',
      text: normalizeText(payload.text),
      filename: normalizeText(payload.filename),
      createdAt: Date.now(),
      messageId: null,
      consumed: false,
    };

    const list = this.byChat.get(id) || [];
    list.push(item);
    this.byChat.set(id, list);
    this.purge(id);
    return item;
  }

  confirm(item, result) {
    if (!item) return null;
    const messageId = extractMessageId(result);
    if (messageId) item.messageId = messageId;
    return item;
  }

  fail(item) {
    if (!item) return;
    item.consumed = true;
    this.purge(item.chatId);
  }

  consumeIfBot(chatId, message = {}) {
    const id = normalizeChatId(chatId || extractChatId(message));
    if (!id) return null;

    this.purge(id);

    const list = this.byChat.get(id) || [];
    const messageId = extractMessageId(message);
    const text = extractText(message);
    const type = extractType(message);
    const filename = extractFilename(message);
    const now = Date.now();

    const match = list.find((item) => {
      if (!item || item.consumed) return false;
      if (messageId && item.messageId && item.messageId === messageId) return true;

      const recent = (now - item.createdAt) <= this.recentMatchWindowMs;
      if (!recent) return false;

      const sameType = !item.type
        || item.type === type
        || (item.type === 'text' && type === 'chat')
        || (item.type === 'list' && ['chat', 'list', 'text'].includes(type))
        || (item.type === 'image' && ['image', 'chat'].includes(type))
        || (item.type === 'document' && ['document', 'chat'].includes(type));

      if (!sameType) return false;

      if (item.type === 'list' && !text) return true;

      const media = isMediaType(item.type) || isMediaType(type);
      if (media) {
        if (item.filename && filename && item.filename === filename) return true;
        if (looksLikeEncodedMedia(text)) return true;
        if (!text && (!item.text || !filename || !item.filename)) return true;
      }

      if (item.text && text) {
        return item.text === text || text.includes(item.text) || item.text.includes(text);
      }

      return !item.text && !text;
    }) || null;

    if (!match) return null;
    match.consumed = true;
    this.purge(id);
    return match;
  }

  stats(chatId = '') {
    const id = normalizeChatId(chatId);
    if (id) return { chatId: id, pending: (this.byChat.get(id) || []).length };
    let pending = 0;
    for (const list of this.byChat.values()) pending += list.length;
    return { pending };
  }

  clearAll() {
    const count = this.stats().pending;
    this.byChat.clear();
    return count;
  }

  clearChats(chatIds = []) {
    const selected = [...new Set(
      (Array.isArray(chatIds) ? chatIds : [chatIds])
        .map(normalizeChatId)
        .filter(Boolean),
    )];
    let count = 0;
    for (const chatId of selected) {
      count += (this.byChat.get(chatId) || []).length;
      this.byChat.delete(chatId);
    }
    return count;
  }
}

module.exports = {
  OutboundTracker,
  _test: {
    extractChatId,
    extractFilename,
    extractMessageId,
    extractText,
    extractType,
    isMediaType,
    looksLikeEncodedMedia,
    normalizeChatId,
    normalizeText,
  },
};
