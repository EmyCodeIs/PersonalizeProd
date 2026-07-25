'use strict';

const { decisionError } = require('./decisionLogger');

function normalizeBufferId(clientId) {
  const raw = String(clientId || '').trim();
  if (!raw) return '';
  return raw;
}

class BufferManager {
  constructor({ delayMs, onFlush }) {
    this.delayMs = Math.max(500, Number(delayMs || 4500));
    this.onFlush = onFlush;
    this.map = new Map();
  }

  push(clientId, message, options = {}) {
    const id = normalizeBufferId(clientId);
    if (!id) return;

    const item = this.map.get(id) || { messages: [], timer: null };
    item.messages.push({ ...message, chatId: id });

    if (item.timer) clearTimeout(item.timer);
    const requestedDelay = Number(options.delayMs);
    const effectiveDelay = Number.isFinite(requestedDelay)
      ? Math.max(100, requestedDelay)
      : this.delayMs;

    item.timer = setTimeout(async () => {
      const current = this.map.get(id);
      this.map.delete(id);
      if (!current?.messages?.length) return;
      await this.onFlush(id, current.messages).catch((err) => {
        decisionError('buffer_flush_falhou', err, { chat: id, quantidade: current.messages.length });
        console.error('[BUFFER] flush error:', err?.message || err);
      });
    }, effectiveDelay);

    if (typeof item.timer.unref === 'function') item.timer.unref();
    item.delayMs = effectiveDelay;
    this.map.set(id, item);
  }

  clear(clientId) {
    const id = normalizeBufferId(clientId);
    const item = this.map.get(id);
    if (item?.timer) clearTimeout(item.timer);
    this.map.delete(id);
    return Array.isArray(item?.messages) ? item.messages.length : 0;
  }
}

function mergeMessages(messages = []) {
  return messages
    .map((msg) => msg?.interactiveId || msg?.text || msg?.body || msg?.caption || '')
    .map((text) => String(text || '').trim())
    .filter(Boolean)
    .join('\n');
}

module.exports = { BufferManager, mergeMessages, normalizeBufferId };
