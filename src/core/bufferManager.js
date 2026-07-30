'use strict';

const { decision, decisionError } = require('./decisionLogger');

function normalizeBufferId(clientId) {
  const raw = String(clientId || '').trim();
  if (!raw) return '';
  return raw;
}

function configuredNumber(name, fallback, minimum = 1) {
  const value = Number(process.env[name]);
  return Math.max(minimum, Number.isFinite(value) ? value : fallback);
}

function explicitOrConfigured(explicit, name, fallback, productionMinimum, explicitMinimum = 1) {
  const value = Number(explicit);
  if (explicit !== undefined && explicit !== null && Number.isFinite(value)) {
    return Math.max(explicitMinimum, value);
  }
  return configuredNumber(name, fallback, productionMinimum);
}

function messageBytes(message = {}) {
  const fields = [
    message?.interactiveId,
    message?.text,
    message?.body,
    message?.caption,
    message?.filename,
    message?.fileName,
    message?.mimetype,
    message?.type,
  ];
  return Buffer.byteLength(fields.map((value) => String(value || '')).join('\n'), 'utf8');
}

class BufferManager {
  constructor({
    delayMs,
    onFlush,
    maxMessagesPerChat,
    maxBytesPerChat,
    maxActiveChats,
  }) {
    this.delayMs = Math.max(500, Number(delayMs || 4500));
    this.onFlush = onFlush;
    this.maxMessagesPerChat = explicitOrConfigured(
      maxMessagesPerChat,
      'BUFFER_MAX_MESSAGES_PER_CHAT',
      30,
      2,
      1,
    );
    this.maxBytesPerChat = explicitOrConfigured(
      maxBytesPerChat,
      'BUFFER_MAX_BYTES_PER_CHAT',
      32768,
      4096,
      1,
    );
    this.maxActiveChats = explicitOrConfigured(
      maxActiveChats,
      'BUFFER_MAX_ACTIVE_CHATS',
      200,
      10,
      1,
    );
    this.map = new Map();
    this.pendingFlushes = new Set();
  }

  _trackFlush(action) {
    let operation;
    operation = Promise.resolve()
      .then(action)
      .finally(() => this.pendingFlushes.delete(operation));
    this.pendingFlushes.add(operation);
    return operation;
  }

  _flush(id, reason = 'timer') {
    const current = this.map.get(id);
    if (!current) return 0;

    if (current.timer) clearTimeout(current.timer);
    this.map.delete(id);
    if (!current.messages?.length) return 0;

    const messages = current.messages;
    this._trackFlush(() => this.onFlush(id, messages))
      .catch((err) => {
        decisionError('buffer_flush_falhou', err, { chat: id, quantidade: messages.length, motivo: reason });
        console.error('[BUFFER] flush error:', err?.message || err);
      });

    if (reason !== 'timer') {
      decision('BUFFER', 'descarregado_por_limite', {
        chat: id,
        quantidade: messages.length,
        motivo: reason,
      });
    }
    return messages.length;
  }

  _oldestId() {
    let selected = null;
    let oldest = Number.POSITIVE_INFINITY;
    for (const [id, item] of this.map.entries()) {
      const timestamp = Number(item?.updatedAt || item?.createdAt || 0);
      if (timestamp < oldest) {
        oldest = timestamp;
        selected = id;
      }
    }
    return selected;
  }

  _ensureCapacity(nextId) {
    if (this.map.has(nextId)) return;
    while (this.map.size >= this.maxActiveChats) {
      const oldestId = this._oldestId();
      if (!oldestId) break;
      this._flush(oldestId, 'capacidade_global');
    }
  }

  push(clientId, message, options = {}) {
    const id = normalizeBufferId(clientId);
    if (!id) return;

    this._ensureCapacity(id);

    const bytes = messageBytes(message);
    let item = this.map.get(id) || {
      messages: [],
      timer: null,
      bytes: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const exceedsMessages = item.messages.length >= this.maxMessagesPerChat;
    const exceedsBytes = item.messages.length > 0 && (item.bytes + bytes) > this.maxBytesPerChat;
    if (exceedsMessages || exceedsBytes) {
      this._flush(id, exceedsMessages ? 'mensagens_por_chat' : 'bytes_por_chat');
      item = {
        messages: [],
        timer: null,
        bytes: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
    }

    item.messages.push({ ...message, chatId: id });
    item.bytes += bytes;
    item.updatedAt = Date.now();

    if (item.timer) clearTimeout(item.timer);
    const requestedDelay = Number(options.delayMs);
    const effectiveDelay = Number.isFinite(requestedDelay)
      ? Math.max(100, requestedDelay)
      : this.delayMs;

    this.map.set(id, item);

    // Uma única mensagem anormalmente grande é processada imediatamente. O conteúdo
    // não é truncado nem descartado; apenas deixa de permanecer acumulado na memória.
    if (bytes > this.maxBytesPerChat) {
      this._flush(id, 'mensagem_grande');
      return;
    }

    item.timer = setTimeout(() => this._flush(id, 'timer'), effectiveDelay);
    if (typeof item.timer.unref === 'function') item.timer.unref();
    item.delayMs = effectiveDelay;
  }

  clear(clientId) {
    const id = normalizeBufferId(clientId);
    const item = this.map.get(id);
    if (item?.timer) clearTimeout(item.timer);
    this.map.delete(id);
    return Array.isArray(item?.messages) ? item.messages.length : 0;
  }

  clearAll() {
    let removed = 0;
    for (const id of [...this.map.keys()]) removed += this.clear(id);
    return removed;
  }

  async drainAll(reason = 'encerramento') {
    let flushed = 0;
    for (const id of [...this.map.keys()]) flushed += this._flush(id, reason);

    while (this.pendingFlushes.size) {
      await Promise.allSettled([...this.pendingFlushes]);
    }
    return flushed;
  }

  sweep({ maxAgeMs } = {}) {
    const threshold = Math.max(this.delayMs * 4, Number(maxAgeMs || this.delayMs * 4));
    const now = Date.now();
    let flushed = 0;
    for (const [id, item] of [...this.map.entries()]) {
      if ((now - Number(item?.updatedAt || 0)) <= threshold) continue;
      flushed += this._flush(id, 'buffer_estagnado');
    }
    return flushed;
  }

  stats() {
    let messages = 0;
    let bytes = 0;
    for (const item of this.map.values()) {
      messages += Number(item?.messages?.length || 0);
      bytes += Number(item?.bytes || 0);
    }
    return {
      // Descargas em andamento continuam contando como trabalho ativo. Isso impede
      // o encerramento de considerar o buffer vazio antes de onFlush realmente terminar.
      activeChats: this.map.size + this.pendingFlushes.size,
      messages,
      bytes,
      pendingFlushes: this.pendingFlushes.size,
      maxActiveChats: this.maxActiveChats,
      maxMessagesPerChat: this.maxMessagesPerChat,
      maxBytesPerChat: this.maxBytesPerChat,
    };
  }
}

function mergeMessages(messages = []) {
  return messages
    .map((msg) => msg?.interactiveId || msg?.text || msg?.body || msg?.caption || '')
    .map((text) => String(text || '').trim())
    .filter(Boolean)
    .join('\n');
}

module.exports = {
  BufferManager,
  explicitOrConfigured,
  mergeMessages,
  messageBytes,
  normalizeBufferId,
};
