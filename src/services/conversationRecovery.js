'use strict';

const crypto = require('crypto');
const Identity = require('./contactIdentity');
const Inbox = require('./messageInboxStore');
const BotActivity = require('./botActivityStore');
const Cursor = require('./conversationCursorStore');
const { recoveryConfig } = require('../config/recoveryConfig');

function clean(value, maxLength = 4000) {
  const text = String(value ?? '').trim();
  return text ? text.slice(0, maxLength) : '';
}

function messageId(message = {}) {
  return clean(
    message?.__personalizeOriginalMessageId
    || message?.id?._serialized
    || (typeof message?.id === 'string' ? message.id : '')
    || message?.messageId
    || message?.key?.id,
    260,
  ) || null;
}

function timestampMs(message = {}) {
  for (const candidate of [message?.timestamp, message?.t, message?.messageTimestamp, message?.id?.timestamp]) {
    const numeric = Number(candidate);
    if (!Number.isFinite(numeric) || numeric <= 0) continue;
    return numeric < 1000000000000 ? numeric * 1000 : numeric;
  }
  return 0;
}

function mediaMarker(message = {}) {
  const type = clean(message?.type || message?.mimetype || message?.mediaType, 120).toLowerCase();
  const filename = clean(message?.filename || message?.fileName || message?.document?.filename, 240);
  if (/image/.test(type)) return '[imagem enviada]';
  if (/document|pdf|application/.test(type) || filename) return `[arquivo enviado${filename ? `: ${filename}` : ''}]`;
  if (/video/.test(type)) return '[vídeo enviado]';
  if (/audio|ptt/.test(type)) return '[áudio enviado]';
  return '';
}

function visibleText(message = {}) {
  return clean(message?.body || message?.caption || message?.text || message?.content, 4000) || mediaMarker(message);
}

function messageChatId(message = {}, fallbackChatId = '') {
  return clean(
    message?.from
    || message?.chatId
    || message?.id?.remote
    || message?.key?.remoteJid
    || fallbackChatId,
    180,
  );
}

function isIncomingVisible(message = {}, fallbackChatId = '') {
  if (message?.fromMe) return false;
  const chatId = messageChatId(message, fallbackChatId);
  if (!chatId || /@g\.us$/i.test(chatId) || message?.isGroupMsg) return false;
  return Boolean(visibleText(message));
}

function normalizeHistoryMessage(message = {}, fallbackChatId = '') {
  if (!isIncomingVisible(message, fallbackChatId)) return null;
  const from = messageChatId(message, fallbackChatId);
  return {
    from,
    text: visibleText(message),
    raw: message,
    messageId: messageId(message),
    timestamp: timestampMs(message),
  };
}

function sortMessages(messages = []) {
  return [...messages].sort((a, b) => {
    const at = Number(a?.timestamp || timestampMs(a?.raw || a) || 0);
    const bt = Number(b?.timestamp || timestampMs(b?.raw || b) || 0);
    if (at !== bt) return at - bt;
    return String(a?.messageId || messageId(a?.raw || a) || '')
      .localeCompare(String(b?.messageId || messageId(b?.raw || b) || ''));
  });
}

function dedupeMessages(messages = []) {
  const seen = new Set();
  const output = [];
  for (const item of sortMessages(messages)) {
    const id = item?.messageId || messageId(item?.raw || item);
    const key = id || `${item?.from || ''}|${item?.timestamp || ''}|${item?.text || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(item);
  }
  return output;
}

function activeSessionTimestamp(session = {}) {
  const values = [session.lastInteractionAt, session.updatedAt, session.createdAt];
  for (const value of values) {
    const parsed = new Date(value || 0).getTime();
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 0;
}

function baselineForSession(session = {}) {
  const clientId = session.chatId || session.clientId || session.id;
  const sessionAt = activeSessionTimestamp(session);
  const checkpoint = (() => {
    try { return BotActivity.getLastBotOutbound(clientId); } catch (_) { return null; }
  })();
  const checkpointAt = new Date(checkpoint?.at || 0).getTime();
  return {
    at: Math.max(sessionAt, Number.isFinite(checkpointAt) ? checkpointAt : 0),
    messageId: checkpoint?.messageId || null,
    source: checkpointAt >= sessionAt ? 'bot_checkpoint' : 'session_state',
  };
}

function candidateChatIds(clientId) {
  const values = [];
  try { values.push(Identity.normalizeChatId(clientId)); } catch (_) {}
  try { values.push(...Identity.getLabelCandidateIds(clientId)); } catch (_) {}
  return [...new Set(values.map((item) => clean(item, 180)).filter(Boolean))];
}

async function readConversationHistory(client, clientId, options = {}) {
  const limit = Math.max(20, Number(options.limit || recoveryConfig.historyLimit));
  const candidates = candidateChatIds(clientId);
  let available = false;

  for (const chatId of candidates) {
    if (typeof client?.getAllMessagesInChat !== 'function') continue;
    try {
      const raw = await client.getAllMessagesInChat(chatId, true, false);
      const messages = Array.isArray(raw) ? raw : Object.values(raw || {});
      available = true;
      if (messages.length) return { available: true, chatId, messages: messages.slice(-limit) };
    } catch (_) {}
  }

  if (client?.page?.evaluate) {
    for (const chatId of candidates) {
      try {
        const raw = await client.page.evaluate(async ({ chatId: target, count }) => {
          const WPP = window.WPP || null;
          if (typeof WPP?.chat?.getMessages !== 'function') return null;
          const result = await WPP.chat.getMessages(target, { count, direction: 'before' });
          return Array.isArray(result) ? result : Object.values(result || {});
        }, { chatId, count: limit });
        if (Array.isArray(raw)) {
          available = true;
          if (raw.length) return { available: true, chatId, messages: raw.slice(-limit) };
        }
      } catch (_) {}
    }
  }

  return { available, chatId: candidates[0] || null, messages: [] };
}

function selectAfterCursor(clientId, messages = [], options = {}) {
  const normalized = dedupeMessages(
    (messages || []).map((message) => normalizeHistoryMessage(message, clientId)).filter(Boolean),
  );
  const selected = [];
  const skipped = [];

  for (const item of normalized) {
    const decision = Cursor.shouldRecover(clientId, {
      messageId: item.messageId,
      sourceTimestamp: item.timestamp,
      raw: item.raw,
    }, {
      now: options.now,
      maxAgeHours: options.maxAgeHours || recoveryConfig.maxAgeHours,
      graceMs: options.graceMs ?? recoveryConfig.baselineGraceMs,
    });
    if (decision.recover) selected.push(item);
    else skipped.push({ item, reason: decision.reason });
  }

  return { selected, skipped, total: normalized.length };
}

function stageMessage(item, source) {
  const identity = (() => {
    try { return Identity.registerContact({ chatId: item.from, raw: item.raw }); } catch (_) { return null; }
  })();
  const canonical = identity?.primaryChatId || item.from;
  const received = Inbox.receive({
    from: canonical,
    conversationId: canonical,
    text: item.text,
    raw: item.raw,
    source,
  });
  const record = Inbox.readRecord(received.record.id) || received.record;
  if (!record || Inbox.TERMINAL.has(record.status)) {
    return { staged: false, duplicate: received.duplicate, record };
  }

  const sourceAt = item.timestamp || Date.now();
  record.conversationId = canonical;
  record.from = canonical;
  record.sourceTimestamp = sourceAt;
  record.receivedAt = new Date(sourceAt).toISOString();
  record.lastSeenAt = new Date().toISOString();
  record.recoverySource = source;
  Inbox.writeRecord(record);
  Inbox.transition([record.id], Inbox.STATUS.FAILED_RETRYABLE, {
    reason: 'cursor_recovery_pending',
    patch: {
      availableAt: new Date().toISOString(),
      leaseOwner: null,
      leaseExpiresAt: null,
      lastError: 'CURSOR_RECOVERY_PENDING',
    },
  });
  Cursor.observeReceived(canonical, record);
  return { staged: true, duplicate: received.duplicate, record: Inbox.readRecord(record.id) };
}

function stageSelected(clientId, selected = [], options = {}) {
  const source = clean(options.source, 100) || 'cursor-recovery';
  const stagedIds = [];
  let duplicates = 0;
  for (const item of sortMessages(selected)) {
    const result = stageMessage({ ...item, from: item.from || clientId }, source);
    if (result.duplicate) duplicates += 1;
    if (result.staged) stagedIds.push(result.record.id);
  }
  Cursor.markRecovery(clientId, {
    source,
    found: selected.length,
    staged: stagedIds.length,
    skipped: duplicates,
  });
  return { stagedIds, duplicates };
}

async function stageConversation({ client, clientId, session = null, source = 'active-session' } = {}) {
  if (!client || !clientId) return { available: false, found: 0, staged: 0, skipped: 0 };
  if (session) {
    const baseline = baselineForSession(session);
    Cursor.ensureBaseline(clientId, {
      at: baseline.at,
      messageId: baseline.messageId,
      source: baseline.source,
      session,
    });
  }

  const history = await readConversationHistory(client, clientId);
  if (!history.available) return { available: false, found: 0, staged: 0, skipped: 0 };
  const selection = selectAfterCursor(clientId, history.messages);
  const staged = stageSelected(clientId, selection.selected, { source: `cursor-${source}` });
  return {
    available: true,
    found: selection.total,
    eligible: selection.selected.length,
    staged: staged.stagedIds.length,
    skipped: selection.skipped.length,
    duplicates: staged.duplicates,
    ids: staged.stagedIds,
  };
}

async function stageActiveSessions({ channel, sessions = [], canRecover = null } = {}) {
  const active = (sessions || [])
    .filter((session) => !session?.completed && !session?.dados?.botDone)
    .filter((session) => {
      const stage = clean(session?.etapa, 80);
      return stage && stage !== 'inicio' && stage !== 'concluido';
    })
    .sort((a, b) => activeSessionTimestamp(b) - activeSessionTimestamp(a))
    .slice(0, recoveryConfig.maxChats);

  const summary = { conversations: active.length, found: 0, eligible: 0, staged: 0, skipped: 0 };
  for (const session of active) {
    const clientId = session.chatId || session.clientId || session.id;
    if (typeof canRecover === 'function') {
      const decision = await canRecover(clientId, session);
      if (decision === false || decision?.blocked) {
        summary.skipped += 1;
        continue;
      }
    }
    const result = await stageConversation({
      client: channel?.client,
      clientId,
      session,
      source: 'active-session',
    });
    summary.found += result.found || 0;
    summary.eligible += result.eligible || 0;
    summary.staged += result.staged || 0;
    summary.skipped += result.skipped || 0;
  }
  return summary;
}

async function listChatsCompat(client) {
  if (typeof client?.listChats === 'function') return client.listChats();
  if (typeof client?.getAllChats === 'function') return client.getAllChats();
  if (typeof client?.getAllChatsWithMessages === 'function') return client.getAllChatsWithMessages();
  return [];
}

function chatIdOf(chat = {}) {
  return clean(chat?.id?._serialized || chat?.id || chat?.contact?.id?._serialized, 180);
}

async function unreadMessagesFromDirectMethods(client) {
  const output = [];
  for (const method of ['getUnreadMessages', 'getAllUnreadMessages']) {
    if (typeof client?.[method] !== 'function') continue;
    try {
      const raw = await client[method]();
      const list = Array.isArray(raw) ? raw : Object.values(raw || {});
      output.push(...list);
      if (list.length) break;
    } catch (error) {
      console.warn(`[CURSOR] ${method} falhou:`, error?.message || error);
    }
  }
  return output;
}

async function stageUnreadMessages({ channel, client } = {}) {
  const targetClient = client || channel?.client;
  if (!targetClient) return { conversations: 0, found: 0, eligible: 0, staged: 0, skipped: 0 };

  const grouped = new Map();
  for (const message of await unreadMessagesFromDirectMethods(targetClient)) {
    const normalized = normalizeHistoryMessage(message);
    if (!normalized) continue;
    if (!grouped.has(normalized.from)) grouped.set(normalized.from, []);
    grouped.get(normalized.from).push(message);
  }

  let chats = [];
  try {
    const raw = await listChatsCompat(targetClient);
    chats = Array.isArray(raw) ? raw : Object.values(raw || {});
  } catch (error) {
    console.warn('[CURSOR] não foi possível listar chats não lidos:', error?.message || error);
  }

  const unreadChats = chats
    .filter((chat) => !chat?.isGroup && !chat?.isGroupMsg && !/@g\.us$/i.test(chatIdOf(chat)))
    .filter((chat) => Number(chat?.unreadCount || chat?.unread || chat?.unreadMessages || 0) > 0)
    .slice(0, recoveryConfig.maxChats);

  for (const chat of unreadChats) {
    const chatId = chatIdOf(chat);
    if (!chatId) continue;
    let messages = Array.isArray(chat?.msgs) ? chat.msgs : Array.isArray(chat?.messages) ? chat.messages : [];
    if (!messages.length) {
      const history = await readConversationHistory(targetClient, chatId);
      messages = history.messages;
    }
    if (!grouped.has(chatId)) grouped.set(chatId, []);
    grouped.get(chatId).push(...messages);
  }

  const summary = { conversations: grouped.size, found: 0, eligible: 0, staged: 0, skipped: 0 };
  for (const [clientId, messages] of grouped.entries()) {
    // A sinalização de não lida apenas identifica a conversa. A seleção oficial
    // lê o histórico limitado e recupera todas as entradas posteriores ao cursor.
    const history = await readConversationHistory(targetClient, clientId);
    const sourceMessages = history.available && history.messages.length
      ? [...messages, ...history.messages]
      : messages;
    const selection = selectAfterCursor(clientId, sourceMessages, { graceMs: 0 });
    const staged = stageSelected(clientId, selection.selected, { source: 'cursor-unread' });
    summary.found += selection.total;
    summary.eligible += selection.selected.length;
    summary.staged += staged.stagedIds.length;
    summary.skipped += selection.skipped.length;
  }
  return summary;
}

async function recoverStaged(channel, reason = 'cursor-recovery') {
  if (typeof channel?.__runPersistentInboxRecovery !== 'function') {
    return { rounds: 0, found: 0, replayed: 0, ignored: 0, unavailable: true };
  }
  const summary = { rounds: 0, found: 0, replayed: 0, ignored: 0 };
  for (let round = 1; round <= recoveryConfig.maxRounds; round += 1) {
    const result = await channel.__runPersistentInboxRecovery(`${reason}-r${round}`);
    summary.rounds = round;
    summary.found += Number(result?.found || 0);
    summary.replayed += Number(result?.replayed || 0);
    summary.ignored += Number(result?.ignored || 0);
    if (!result?.found) break;
  }
  return summary;
}

function batchId(prefix = 'recovery') {
  return `${prefix}:${Date.now()}:${crypto.randomBytes(4).toString('hex')}`;
}

module.exports = {
  activeSessionTimestamp,
  baselineForSession,
  batchId,
  candidateChatIds,
  dedupeMessages,
  isIncomingVisible,
  messageChatId,
  messageId,
  normalizeHistoryMessage,
  readConversationHistory,
  recoverStaged,
  selectAfterCursor,
  sortMessages,
  stageActiveSessions,
  stageConversation,
  stageSelected,
  stageUnreadMessages,
  timestampMs,
  visibleText,
};
