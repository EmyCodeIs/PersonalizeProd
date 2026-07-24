'use strict';

const BotActivity = require('../services/botActivityStore');
const HumanControl = require('../services/humanControlStore');
const Identity = require('../services/contactIdentity');
const Store = require('../services/leadStore');
const { env } = require('../config/env');
const { clearServiceLabelCache } = require('./idempotentServiceLabels');
const { isTestCommandAuthorized } = require('./testCommandAccess');

const SYSTEM_RESET_COMMAND = '/resetarsys';
const SYSTEM_RESET_RESPONSE_TITLE = 'Conversa zerada para teste.';
const RECOVERY_SOURCES = new Set(['history-recovery', 'unread-bootstrap', 'startup-recovery']);
const processedCommandIds = new Set();
let activeReset = null;

function firstLine(value) {
  return String(value || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) || '';
}

function isSystemResetCommand(value) {
  return firstLine(value).toLowerCase() === SYSTEM_RESET_COMMAND;
}

function messageId(raw = {}) {
  return String(
    raw?.id?._serialized
    || raw?.id
    || raw?.messageId
    || raw?.key?.id
    || ''
  ).trim();
}

function timestampMs(raw = {}) {
  const candidates = [
    raw?.timestamp,
    raw?.t,
    raw?.messageTimestamp,
    raw?.id?.timestamp,
  ];
  for (const candidate of candidates) {
    const value = Number(candidate);
    if (!Number.isFinite(value) || value <= 0) continue;
    return value < 1000000000000 ? value * 1000 : value;
  }
  return null;
}

function isHistoricalCommand({ raw = {}, source = 'event', now = Date.now() } = {}) {
  if (RECOVERY_SOURCES.has(String(source || '').trim().toLowerCase())) return true;

  const timestamp = timestampMs(raw);
  if (timestamp === null) return false;
  return timestamp < (now - (2 * 60 * 1000));
}

function normalizeChatId(value) {
  const serialized = value && typeof value === 'object'
    ? (value._serialized || value.id?._serialized || value.id || '')
    : value;
  const raw = String(serialized || '').trim().toLowerCase();
  if (!raw) return '';
  if (/@(c\.us|g\.us|lid)$/i.test(raw)) return raw;
  const digits = raw.replace(/\D/g, '');
  return digits ? `${digits}@c.us` : '';
}

function normalizePhone(value) {
  let digits = String(value || '').replace(/\D/g, '');
  if (digits.length === 10 || digits.length === 11) digits = `55${digits}`;
  return digits;
}

function candidateChatIds(clientId) {
  const direct = normalizeChatId(clientId);
  const candidates = [direct];

  try {
    if (typeof Identity.getLabelCandidateIds === 'function') {
      candidates.push(...Identity.getLabelCandidateIds(clientId));
    }
  } catch (_) {}

  const mapped = direct.endsWith('@lid')
    ? normalizePhone(env.lidNumberMap?.[direct])
    : '';
  if (mapped) candidates.push(`${mapped}@c.us`);

  return [...new Set(candidates.map(normalizeChatId).filter(Boolean))];
}

function logReset(event, details = {}, level = 'info') {
  const suffix = Object.entries(details)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(' | ');
  const message = `[RESETARSYS] ${event}${suffix ? ` | ${suffix}` : ''}`;
  if (level === 'warn') console.warn(message);
  else console.log(message);
}

async function clearContactNote(channel, candidates) {
  const client = channel?.client;
  if (!client?.page?.evaluate) {
    return { cleared: false, found: 0, error: 'NOTE_PAGE_UNAVAILABLE' };
  }

  try {
    return await client.page.evaluate(async ({ candidates }) => {
      const WPP = window.WPP || null;
      const visible = (value) => String(value || '')
        .replace(/[\s\u200B\u200C\u200D\u2060\uFEFF]/g, '');
      const noteContent = (note) => (
        note?.content
        ?? note?.attributes?.content
        ?? note?._value?.content
        ?? ''
      );
      const getNote = async (chatId) => {
        if (typeof WPP?.chat?.getNotes === 'function') return WPP.chat.getNotes(chatId);
        if (typeof WPP?.contact?.getNotes === 'function') return WPP.contact.getNotes(chatId);
        throw new Error('NOTE_GET_API_UNAVAILABLE');
      };
      const setNote = async (chatId, content) => {
        if (typeof WPP?.chat?.setNotes === 'function') return WPP.chat.setNotes(chatId, content);
        if (typeof WPP?.contact?.setNotes === 'function') return WPP.contact.setNotes(chatId, content);
        throw new Error('NOTE_SET_API_UNAVAILABLE');
      };
      const deleteMethods = [
        [WPP?.chat, 'deleteNotes'],
        [WPP?.chat, 'removeNotes'],
        [WPP?.chat, 'clearNotes'],
        [WPP?.contact, 'deleteNotes'],
        [WPP?.contact, 'removeNotes'],
        [WPP?.contact, 'clearNotes'],
      ];

      let found = 0;
      const failures = [];
      const clearedChatIds = [];

      for (const chatId of candidates) {
        let before;
        try {
          before = await getNote(chatId);
        } catch (error) {
          failures.push(`${chatId}:${error?.message || error}`);
          continue;
        }

        if (!before || !visible(noteContent(before))) continue;
        found += 1;
        let cleared = false;

        for (const [scope, method] of deleteMethods) {
          if (typeof scope?.[method] !== 'function') continue;
          try {
            await scope[method](chatId);
            const after = await getNote(chatId).catch(() => null);
            if (!after || !visible(noteContent(after))) {
              cleared = true;
              break;
            }
          } catch (_) {}
        }

        if (!cleared) {
          try {
            await setNote(chatId, '');
            const after = await getNote(chatId).catch(() => null);
            cleared = !after || !visible(noteContent(after));
          } catch (_) {}
        }

        if (cleared) clearedChatIds.push(chatId);
        else failures.push(`${chatId}:NOTE_CONTENT_REMAINED`);
      }

      return {
        cleared: failures.length === 0,
        found,
        clearedChatIds,
        error: failures.length ? failures.join(' | ') : null,
      };
    }, { candidates });
  } catch (error) {
    return {
      cleared: false,
      found: 0,
      clearedChatIds: [],
      error: error?.message || String(error),
    };
  }
}

async function clearContactLabels(channel, candidates) {
  const client = channel?.client;
  if (!client?.page?.evaluate) {
    return { requested: 0, removed: 0, remaining: null, error: 'LABEL_PAGE_UNAVAILABLE' };
  }

  try {
    return await client.page.evaluate(async ({ candidates }) => {
      const WPP = window.WPP || null;
      const Store = window.Store || null;
      const labelStore = Store?.Label || Store?.Labels || null;
      const getId = (item) => String(
        item?.id?._serialized
        || item?.id
        || item?.labelId
        || item
        || ''
      ).trim();
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

      if (typeof labelStore?.getLabelsForModel !== 'function') {
        return {
          requested: 0,
          removed: 0,
          remaining: null,
          error: 'LABEL_STORE_UNAVAILABLE',
        };
      }

      const chats = [];
      for (const chatId of candidates) {
        try {
          let chat = Store?.Chat?.get?.(chatId) || null;
          if (!chat && typeof Store?.Chat?.find === 'function') chat = await Store.Chat.find(chatId);
          if (chat) chats.push({ chatId, chat });
        } catch (_) {}
      }

      if (!chats.length) {
        return {
          requested: 0,
          removed: 0,
          remaining: null,
          error: `CONTACT_CHAT_NOT_FOUND:${candidates.join(',')}`,
        };
      }

      const attachedByChat = chats.map(({ chatId, chat }) => {
        const raw = labelStore.getLabelsForModel(chat) || [];
        const labels = Array.isArray(raw) ? raw : Object.values(raw || {});
        return {
          chatId,
          ids: [...new Set(labels.map(getId).filter(Boolean))],
        };
      });
      const requested = attachedByChat.reduce((total, item) => total + item.ids.length, 0);

      for (const { chatId, ids } of attachedByChat) {
        if (!ids.length) continue;
        if (typeof WPP?.labels?.addOrRemoveLabels === 'function') {
          await WPP.labels.addOrRemoveLabels(
            [chatId],
            ids.map((labelId) => ({ labelId, type: 'remove' })),
          );
          continue;
        }
        if (typeof WPP?.lists?.removeChats === 'function') {
          for (const labelId of ids) await WPP.lists.removeChats(labelId, [chatId]);
          continue;
        }
        return {
          requested,
          removed: 0,
          remaining: requested,
          error: 'LABEL_REMOVE_API_UNAVAILABLE',
        };
      }

      let remaining = requested;
      for (let attempt = 0; attempt < 8; attempt += 1) {
        if (attempt > 0) await wait(350);
        remaining = 0;
        for (const { chat } of chats) {
          const raw = labelStore.getLabelsForModel(chat) || [];
          const labels = Array.isArray(raw) ? raw : Object.values(raw || {});
          remaining += [...new Set(labels.map(getId).filter(Boolean))].length;
        }
        if (remaining === 0) break;
      }

      return {
        requested,
        removed: Math.max(0, requested - remaining),
        remaining,
        chatIds: chats.map((item) => item.chatId),
        error: remaining === 0 ? null : 'LABEL_REMOVAL_NOT_CONFIRMED',
      };
    }, { candidates });
  } catch (error) {
    return {
      requested: 0,
      removed: 0,
      remaining: null,
      error: error?.message || String(error),
    };
  }
}

async function clearContact(channel, clientId, candidates = candidateChatIds(clientId)) {
  const note = await clearContactNote(channel, candidates);
  const labels = await clearContactLabels(channel, candidates);
  return {
    candidates,
    note,
    labels,
    ok: note.cleared && labels.remaining === 0 && !labels.error,
  };
}

function formatResponse({ internal, contact, runtime }) {
  const failures = [];
  if (!contact.note.cleared) failures.push(`nota: ${contact.note.error || 'não confirmada'}`);
  if (contact.labels.remaining !== 0 || contact.labels.error) {
    failures.push(`etiquetas: ${contact.labels.error || `${contact.labels.remaining} restante(s)`}`);
  }
  if (runtime.idle === false) failures.push('fila: tarefas em execução não encerraram no prazo');

  const status = failures.length ? 'PARCIAL' : 'OK';
  return [
    SYSTEM_RESET_RESPONSE_TITLE,
    '',
    `Resultado: ${status}`,
    `Sessão apagada: ${internal.sessionRemoved ? 'sim' : 'já estava vazia'}`,
    `Perfil apagado: ${internal.profileRemoved ? 'sim' : 'já estava vazio'}`,
    `Handoffs apagados: ${runtime.handoffsCleared}`,
    `Checkpoints apagados: ${runtime.botActivityCleared}`,
    `Buffers descartados: ${runtime.buffersCleared}`,
    `Tarefas canceladas: ${runtime.queuedCancelled}`,
    `Envios pendentes descartados: ${runtime.outboundCleared}`,
    `Nota do contato: ${contact.note.cleared ? 'apagada' : 'não confirmada'}`,
    `Etiquetas removidas: ${contact.labels.removed ?? 'não confirmado'}`,
    `Etiquetas restantes: ${contact.labels.remaining ?? 'não confirmado'}`,
    ...(failures.length ? ['', `Falhas: ${failures.join(' | ')}`] : []),
    '',
    'Sua próxima mensagem começará um atendimento do zero.',
  ].join('\n');
}

async function executeSystemReset({
  channel,
  clientId,
  raw = {},
  source = 'event',
  buffer = null,
  taskQueue = null,
  processedMessageIds = null,
  repairedServiceLabels = null,
} = {}) {
  const access = isTestCommandAuthorized({ from: clientId, raw });
  if (!access.allowed) {
    logReset('negado', { chat: clientId, motivo: access.reason }, 'warn');
    return { handled: true, executed: false, reason: access.reason };
  }

  if (isHistoricalCommand({ raw, source })) {
    logReset('historico_ignorado', {
      chat: clientId,
      mensagem: messageId(raw) || undefined,
      origem: source,
    });
    return { handled: true, executed: false, reason: 'historical' };
  }

  const commandId = messageId(raw);
  if (commandId && processedCommandIds.has(commandId)) {
    logReset('duplicado_ignorado', {
      chat: clientId,
      mensagem: commandId,
      origem: source,
    });
    return { handled: true, executed: false, reason: 'duplicate' };
  }
  if (commandId) {
    processedCommandIds.add(commandId);
    if (processedCommandIds.size > 500) {
      processedCommandIds.delete(processedCommandIds.values().next().value);
    }
  }

  if (activeReset) {
    logReset('em_andamento', { chat: clientId, origem: source });
    await activeReset;
    return { handled: true, executed: false, reason: 'in_progress' };
  }

  activeReset = (async () => {
    const candidates = candidateChatIds(clientId);
    const runtime = {
      buffersCleared: 0,
      queuedCancelled: 0,
      outboundCleared: 0,
      handoffsCleared: 0,
      botActivityCleared: 0,
      idle: true,
    };

    logReset('iniciado', {
      chat: clientId,
      origem: source,
      autorizacao: access.reason,
      aliases: candidates.length,
    });

    for (const candidate of candidates) {
      runtime.buffersCleared += buffer?.clear?.(candidate) ? 1 : 0;
    }
    runtime.queuedCancelled = Number(
      taskQueue?.cancelQueuedForChats?.(candidates, 'SYSTEM_RESET') || 0,
    );
    runtime.outboundCleared = Number(
      channel?.outboundTracker?.clearChats?.(candidates) || 0,
    );
    runtime.idle = typeof taskQueue?.waitForChatsIdle === 'function'
      ? await taskQueue.waitForChatsIdle(candidates, { timeoutMs: 15000 })
      : true;

    const contact = await clearContact(channel, clientId, candidates);
    const internal = Store.resetConversation(clientId);

    for (const candidate of candidates) {
      try {
        runtime.handoffsCleared += HumanControl.clearBlock(candidate) ? 1 : 0;
      } catch (_) {}
    }
    try { runtime.botActivityCleared = Number(BotActivity.resetContact(clientId) || 0); } catch (_) {}
    try { clearServiceLabelCache(clientId); } catch (_) {}
    try {
      const prefix = `${Store.normalizeClientId(clientId)}:`;
      for (const key of repairedServiceLabels || []) {
        if (String(key).startsWith(prefix)) repairedServiceLabels.delete(key);
      }
    } catch (_) {}

    logReset(contact.note.cleared ? 'nota_limpa' : 'nota_falhou', {
      chat: clientId,
      encontradas: contact.note.found,
      erro: contact.note.error || undefined,
    }, contact.note.cleared ? 'info' : 'warn');
    logReset(contact.labels.remaining === 0 ? 'etiquetas_limpas' : 'etiquetas_falharam', {
      chat: clientId,
      removidas: contact.labels.removed,
      restantes: contact.labels.remaining,
      erro: contact.labels.error || undefined,
    }, contact.labels.remaining === 0 ? 'info' : 'warn');

    const response = formatResponse({ internal, contact, runtime });
    await channel.sendText(clientId, response, { noDelay: true, noTyping: true });

    const ok = contact.ok && runtime.idle;
    logReset('concluido', {
      chat: clientId,
      resultado: ok ? 'OK' : 'PARCIAL',
      sessao: internal.sessionRemoved,
      perfil: internal.profileRemoved,
      handoffs: runtime.handoffsCleared,
      checkpoints: runtime.botActivityCleared,
      buffers: runtime.buffersCleared,
      tarefas: runtime.queuedCancelled,
      envios_pendentes: runtime.outboundCleared,
    }, ok ? 'info' : 'warn');

    return {
      handled: true,
      executed: true,
      ok,
      internal,
      contact,
      runtime,
      response,
    };
  })();

  try {
    return await activeReset;
  } finally {
    activeReset = null;
  }
}

module.exports = {
  SYSTEM_RESET_COMMAND,
  SYSTEM_RESET_RESPONSE_TITLE,
  candidateChatIds,
  clearContact,
  clearContactLabels,
  clearContactNote,
  executeSystemReset,
  firstLine,
  isHistoricalCommand,
  isSystemResetCommand,
  logReset,
  messageId,
  timestampMs,
};
