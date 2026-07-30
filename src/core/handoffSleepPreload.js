'use strict';

const WppClient = require('../services/wppconnectClient');
const HumanControl = require('../services/humanControlStore');
const SellerHandoff = require('./sellerHandoff');
const { isStrictTesterIdentity, isSupportedHandoffReason } = require('./handoffPolicy');
const { decision, decisionError } = require('./decisionLogger');

const LABEL_BLOCK_REASONS = new Set(['seller_label', 'manual_label']);
const IMMEDIATE_COMMANDS = new Set(['/reset', '/reiniciar', '/resetarsys']);
const sleepLogCache = new Map();
const originalGetAutomationBlock = SellerHandoff.getAutomationBlock.bind(SellerHandoff);

function firstLine(value) {
  return String(value || '').split(/\r?\n/).map((line) => line.trim()).find(Boolean) || '';
}

function incomingText(payload = {}) {
  return firstLine(
    payload?.text
    || payload?.raw?.body
    || payload?.raw?.caption
    || payload?.raw?.text
    || '',
  );
}

function isImmediateCommand(payload = {}) {
  return IMMEDIATE_COMMANDS.has(incomingText(payload).toLowerCase());
}

function compactGuard(clientId, control = {}) {
  return {
    blocked: true,
    reason: String(control.reason || 'human_block'),
    seller: control.seller || null,
    labelName: control.labelName || null,
    source: control.source || 'human_control',
    details: control,
    localOnly: true,
    chatId: String(clientId || '').trim() || null,
  };
}

function getLocalAutomationBlock(clientId) {
  if (isStrictTesterIdentity({ from: clientId })) {
    return { blocked: false, reason: null, source: 'tester_identity', localOnly: true };
  }

  let existing;
  try {
    existing = HumanControl.getBlock(clientId);
  } catch (_) {
    return { blocked: false, reason: null, source: 'local_block_unavailable', localOnly: true };
  }

  if (!existing?.blocked) {
    return { blocked: false, reason: null, source: 'local_block_absent', localOnly: true };
  }

  const reason = String(existing.control?.reason || '');
  if (!isSupportedHandoffReason(reason)) {
    try { HumanControl.clearBlock(clientId); } catch (_) {}
    decision('HANDOFF', 'bloqueio_local_legado_removido', {
      chat: clientId,
      status: 'livre',
      motivo: reason || 'sem_motivo',
    });
    return { blocked: false, reason: null, source: 'invalid_local_block_removed', localOnly: true };
  }

  return compactGuard(clientId, existing.control || {});
}

async function getAutomationBlockEfficient(channel, clientId, options = {}) {
  const local = getLocalAutomationBlock(clientId);
  if (!local.blocked) return originalGetAutomationBlock(channel, clientId);

  const forceExternalRefresh = options?.forceExternalRefresh === true;
  if (forceExternalRefresh && LABEL_BLOCK_REASONS.has(local.reason)) {
    return originalGetAutomationBlock(channel, clientId);
  }

  return local;
}

function shouldLogSleepingContact(clientId) {
  const key = String(clientId || '').trim();
  if (!key) return false;
  const now = Date.now();
  const ttlMs = Math.max(10000, Number(process.env.HANDOFF_SLEEP_LOG_TTL_MS || 300000));
  const previous = Number(sleepLogCache.get(key) || 0);
  if (previous && (now - previous) < ttlMs) return false;

  sleepLogCache.delete(key);
  sleepLogCache.set(key, now);
  const maxEntries = Math.max(100, Number(process.env.HANDOFF_SLEEP_LOG_MAX_ENTRIES || 1000));
  while (sleepLogCache.size > maxEntries) {
    const oldest = sleepLogCache.keys().next().value;
    sleepLogCache.delete(oldest);
  }
  return true;
}

async function reconcilePersistentHandoffs(channel, options = {}) {
  const all = typeof HumanControl.listBlocks === 'function'
    ? HumanControl.listBlocks()
    : [];
  const candidates = all.filter((item) => LABEL_BLOCK_REASONS.has(String(item?.reason || '')));
  const configuredLimit = Number(options.limit ?? process.env.HANDOFF_STARTUP_RECONCILE_MAX ?? 200);
  const limit = Math.max(0, Number.isFinite(configuredLimit) ? configuredLimit : 200);
  const selected = candidates.slice(0, limit);

  const result = {
    totalBlocks: all.length,
    labelBlocks: candidates.length,
    checked: 0,
    retained: 0,
    released: 0,
    inconclusive: 0,
    skipped: Math.max(0, candidates.length - selected.length),
  };

  for (const item of selected) {
    const clientId = item?.clientId;
    if (!clientId) continue;
    result.checked += 1;
    try {
      const guard = await originalGetAutomationBlock(channel, clientId);
      if (!guard?.blocked) result.released += 1;
      else {
        result.retained += 1;
        if (guard?.details?.labelInspection?.conclusive === false) result.inconclusive += 1;
      }
    } catch (error) {
      result.inconclusive += 1;
      decisionError('reconciliação_de_handoff_falhou', error, { chat: clientId });
    }
  }

  return result;
}

function installIncomingSleepGuard() {
  if (WppClient.__handoffSleepInstalled) return;
  const originalCreateWppChannel = WppClient.createWppChannel;

  WppClient.createWppChannel = async function createChannelWithSleepingHandoffs(options = {}) {
    const originalOnMessage = options.onMessage;
    const wrappedOptions = { ...options };

    if (typeof originalOnMessage === 'function') {
      wrappedOptions.onMessage = async (payload = {}) => {
        if (isImmediateCommand(payload)) return originalOnMessage(payload);

        const clientId = payload?.from || payload?.chatId || payload?.raw?.from || payload?.raw?.chatId;
        const guard = getLocalAutomationBlock(clientId);
        if (!guard.blocked) return originalOnMessage(payload);

        if (shouldLogSleepingContact(clientId)) {
          decision('HANDOFF', 'contato_adormecido_na_entrada', {
            chat: clientId,
            status: 'bloqueado',
            motivo: guard.reason,
            vendedor: guard.seller || '-',
            etiqueta: guard.labelName || '-',
            resultado: 'sem_sessão_sem_buffer_sem_fila',
          });
        }
        return { ignored: true, reason: 'HUMAN_HANDOFF_SLEEPING', guard };
      };
    }

    const channel = await originalCreateWppChannel.call(this, wrappedOptions);
    const delayMs = Math.max(0, Number(process.env.HANDOFF_STARTUP_RECONCILE_DELAY_MS || 5000));
    const timer = setTimeout(() => {
      reconcilePersistentHandoffs(channel)
        .then((result) => {
          decision('HANDOFF', 'reconciliação_inicial_concluída', {
            bloqueios: result.totalBlocks,
            etiquetas: result.labelBlocks,
            verificados: result.checked,
            mantidos: result.retained,
            liberados: result.released,
            inconclusivos: result.inconclusive,
            adiados: result.skipped,
          });
        })
        .catch((error) => decisionError('reconciliação_inicial_de_handoff_falhou', error));
    }, delayMs);
    timer.unref?.();

    return channel;
  };

  SellerHandoff.getAutomationBlock = getAutomationBlockEfficient;
  SellerHandoff.getLocalAutomationBlock = getLocalAutomationBlock;
  SellerHandoff.reconcilePersistentHandoffs = reconcilePersistentHandoffs;
  WppClient.__handoffSleepInstalled = true;
}

installIncomingSleepGuard();

module.exports = {
  getAutomationBlockEfficient,
  getLocalAutomationBlock,
  incomingText,
  isImmediateCommand,
  reconcilePersistentHandoffs,
  shouldLogSleepingContact,
  _test: {
    LABEL_BLOCK_REASONS,
    sleepLogCache,
  },
};
