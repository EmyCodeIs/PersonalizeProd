'use strict';

const Identity = require('../services/contactIdentity');
const Store = require('../services/leadStore');
const HumanControl = require('../services/humanControlStore');
const BotActivity = require('../services/botActivityStore');
const ResetCheckpoint = require('../services/resetCheckpointStore');
const { clearServiceLabelCache } = require('./idempotentServiceLabels');

const RESET_MODE = Object.freeze({
  TESTER_FULL: 'TESTER_FULL',
  SESSION_ONLY: 'SESSION_ONLY',
});

function normalizeChatId(value) {
  try { return Identity.normalizeChatId(value); } catch (_) {
    const raw = String(value || '').trim().toLowerCase();
    if (!raw) return '';
    if (/@(c\.us|g\.us|lid)$/i.test(raw)) return raw;
    const digits = raw.replace(/\D/g, '');
    return digits ? `${digits}@c.us` : raw;
  }
}

function candidateChatIds(clientId) {
  const values = [normalizeChatId(clientId)];
  try {
    if (typeof Identity.getLabelCandidateIds === 'function') {
      values.push(...Identity.getLabelCandidateIds(clientId).map(normalizeChatId));
    }
  } catch (_) {}
  return [...new Set(values.filter(Boolean))];
}

function markInternalLabelOperations(channel, candidates = []) {
  for (const chatId of candidates) {
    try { channel?.__markInternalLabelOperation?.(chatId); } catch (_) {}
  }
}

async function clearContactNotes(channel, candidates = []) {
  const client = channel?.client;
  if (!client?.page?.evaluate) {
    return { cleared: false, found: 0, failures: 0, error: 'NOTE_PAGE_UNAVAILABLE' };
  }

  try {
    return await client.page.evaluate(async ({ candidates }) => {
      const WPP = window.WPP || null;
      const invisibleBlank = '\u200B';
      const visible = (value) => String(value || '')
        .replace(/[\s\u200B\u200C\u200D\u2060\uFEFF]/g, '');
      const contentOf = (note) => note?.content
        ?? note?.attributes?.content
        ?? note?._value?.content
        ?? '';
      const getNote = async (chatId) => {
        if (typeof WPP?.chat?.getNotes === 'function') return WPP.chat.getNotes(chatId);
        if (typeof WPP?.contact?.getNotes === 'function') return WPP.contact.getNotes(chatId);
        return null;
      };
      const setNote = async (chatId, content) => {
        if (typeof WPP?.chat?.setNotes === 'function') return WPP.chat.setNotes(chatId, content);
        if (typeof WPP?.contact?.setNotes === 'function') return WPP.contact.setNotes(chatId, content);
        throw new Error('NOTE_SET_API_UNAVAILABLE');
      };
      const deleteMethods = [
        [WPP?.chat, 'deleteNotes'], [WPP?.chat, 'removeNotes'], [WPP?.chat, 'clearNotes'],
        [WPP?.contact, 'deleteNotes'], [WPP?.contact, 'removeNotes'], [WPP?.contact, 'clearNotes'],
      ];

      let found = 0;
      let failures = 0;
      for (const chatId of candidates) {
        const before = await getNote(chatId).catch(() => null);
        if (!before || !visible(contentOf(before))) continue;
        found += 1;
        let cleared = false;

        for (const [scope, method] of deleteMethods) {
          if (typeof scope?.[method] !== 'function') continue;
          try {
            await scope[method](chatId);
            const after = await getNote(chatId).catch(() => null);
            if (!after || !visible(contentOf(after))) {
              cleared = true;
              break;
            }
          } catch (_) {}
        }

        if (!cleared) {
          try {
            await setNote(chatId, invisibleBlank);
            const after = await getNote(chatId).catch(() => null);
            cleared = !after || !visible(contentOf(after));
          } catch (_) {}
        }

        if (!cleared) failures += 1;
      }

      return { cleared: failures === 0, found, failures, error: failures ? 'NOTE_CLEAR_NOT_CONFIRMED' : null };
    }, { candidates });
  } catch (error) {
    return { cleared: false, found: 0, failures: 0, error: error?.message || String(error) };
  }
}

async function clearAllContactLabels(channel, candidates = []) {
  const client = channel?.client;
  if (!client?.page?.evaluate) {
    return { removed: 0, remaining: null, error: 'LABEL_PAGE_UNAVAILABLE' };
  }

  markInternalLabelOperations(channel, candidates);

  try {
    const result = await client.page.evaluate(async ({ candidates }) => {
      const WPP = window.WPP || null;
      const Store = window.Store || null;
      const labelStore = Store?.Label || Store?.Labels || null;
      const getId = (item) => String(item?.id?._serialized || item?.id || item?.labelId || item || '').trim();
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

      if (typeof labelStore?.getLabelsForModel !== 'function') {
        return { removed: 0, remaining: null, error: 'LABEL_STORE_UNAVAILABLE' };
      }

      const chats = [];
      for (const chatId of candidates) {
        try {
          let chat = Store?.Chat?.get?.(chatId) || null;
          if (!chat && typeof Store?.Chat?.find === 'function') chat = await Store.Chat.find(chatId);
          if (chat) chats.push({ chatId, chat });
        } catch (_) {}
      }

      if (!chats.length) return { removed: 0, remaining: 0, error: null, chatIds: [] };

      const attachedByChat = [];
      for (const { chatId, chat } of chats) {
        const raw = labelStore.getLabelsForModel(chat) || [];
        const attached = Array.isArray(raw) ? raw : Object.values(raw || {});
        attachedByChat.push({ chatId, ids: [...new Set(attached.map(getId).filter(Boolean))] });
      }

      const requested = attachedByChat.reduce((total, item) => total + item.ids.length, 0);
      const errors = [];

      for (const item of attachedByChat) {
        if (!item.ids.length) continue;
        if (typeof WPP?.labels?.addOrRemoveLabels === 'function') {
          try {
            await WPP.labels.addOrRemoveLabels(
              [item.chatId],
              item.ids.map((labelId) => ({ labelId, type: 'remove' })),
            );
          } catch (error) {
            errors.push(`addOrRemoveLabels:${item.chatId}:${error?.message || error}`);
          }
        } else if (typeof WPP?.lists?.removeChats === 'function') {
          for (const labelId of item.ids) {
            try { await WPP.lists.removeChats(labelId, [item.chatId]); }
            catch (error) { errors.push(`removeChats:${item.chatId}:${labelId}:${error?.message || error}`); }
          }
        } else {
          return { removed: 0, remaining: requested, error: 'LABEL_REMOVE_API_UNAVAILABLE' };
        }
      }

      let remaining = requested;
      for (let attempt = 1; attempt <= 8; attempt += 1) {
        if (attempt > 1) await wait(350);
        remaining = 0;
        for (const { chat } of chats) {
          const raw = labelStore.getLabelsForModel(chat) || [];
          const attached = Array.isArray(raw) ? raw : Object.values(raw || {});
          remaining += [...new Set(attached.map(getId).filter(Boolean))].length;
        }
        if (remaining === 0) break;
      }

      return {
        requested,
        removed: Math.max(0, requested - remaining),
        remaining,
        chatIds: chats.map((item) => item.chatId),
        error: remaining === 0 ? null : (errors.join(' | ') || 'LABEL_REMOVAL_NOT_CONFIRMED'),
      };
    }, { candidates });

    return result;
  } catch (error) {
    return { removed: 0, remaining: null, error: error?.message || String(error) };
  } finally {
    markInternalLabelOperations(channel, candidates);
  }
}

function clearLocalConversationState(clientId, candidates = [], options = {}) {
  const clearBuffer = typeof options.clearBuffer === 'function' ? options.clearBuffer : () => {};
  for (const chatId of candidates) {
    try { clearBuffer(chatId); } catch (_) {}
    try { clearServiceLabelCache(chatId); } catch (_) {}
  }

  const humanBlockCleared = HumanControl.clearBlock(clientId);
  try { BotActivity.clearContact?.(clientId); } catch (_) {}

  const session = typeof Store.resetConversation === 'function'
    ? Store.resetConversation(clientId, { clearProfile: true })
    : Store.resetSession(clientId);

  return { humanBlockCleared, session };
}

async function resetConversation(options = {}) {
  const clientId = normalizeChatId(options.clientId);
  if (!clientId) throw new Error('RESET_CLIENT_ID_REQUIRED');

  const mode = String(options.mode || RESET_MODE.TESTER_FULL).trim().toUpperCase();
  const candidates = candidateChatIds(clientId);
  const checkpoint = ResetCheckpoint.markReset(clientId, {
    command: options.command || '/resetarsys',
    actor: options.actor || 'test_admin',
    mode,
    messageId: options.messageId || null,
  });

  const local = clearLocalConversationState(clientId, candidates, options);
  let external = { note: null, labels: null };

  if (mode === RESET_MODE.TESTER_FULL) {
    const cleanup = typeof options.cleanupExternal === 'function'
      ? await options.cleanupExternal({ channel: options.channel, clientId, candidates, mode })
      : {
          note: await clearContactNotes(options.channel, candidates),
          labels: await clearAllContactLabels(options.channel, candidates),
        };
    external = cleanup || external;
  }

  const externalOk = mode !== RESET_MODE.TESTER_FULL
    || (external?.note?.cleared === true
      && Number(external?.labels?.remaining ?? 0) === 0
      && !external?.labels?.error);

  const result = {
    ok: externalOk,
    mode,
    clientId,
    candidates,
    checkpoint,
    local,
    external,
  };

  console.log(
    `[RESETARSYS][ÚNICO] cliente=${clientId} | modo=${mode} `
    + `| aliases=${candidates.join(',') || '-'} `
    + `| bloqueio=${local.humanBlockCleared ? 'limpo' : 'já_livre'} `
    + `| nota=${external?.note?.cleared === true ? 'limpa' : (mode === RESET_MODE.TESTER_FULL ? 'não_confirmada' : 'não_aplicável')} `
    + `| etiquetasRestantes=${external?.labels?.remaining ?? (mode === RESET_MODE.TESTER_FULL ? 'não_confirmado' : 'não_aplicável')} `
    + `| resultado=${externalOk ? 'OK' : 'PARCIAL'}`,
  );

  return result;
}

function formatResetConfirmation(result = {}) {
  if (result.ok) {
    return 'Sistema resetado para teste.\n\nSua conversa, bloqueio, nota e etiquetas foram limpos. Envie uma nova mensagem para começar como primeiro contato.';
  }
  return 'Sistema resetado para teste.\n\nA conversa e o bloqueio foram zerados, mas a limpeza da nota ou das etiquetas não foi confirmada. Verifique o contato antes de continuar o teste.';
}

module.exports = {
  RESET_MODE,
  candidateChatIds,
  clearAllContactLabels,
  clearContactNotes,
  clearLocalConversationState,
  formatResetConfirmation,
  normalizeChatId,
  resetConversation,
};
