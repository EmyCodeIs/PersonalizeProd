'use strict';

const SellerHandoff = require('./sellerHandoff');
const HumanControl = require('../services/humanControlStore');
const Store = require('../services/leadStore');
const Identity = require('../services/contactIdentity');
const LabelPolicy = require('./labelPolicy');
const { env } = require('../config/env');

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms || 0))));
}

function serializedId(value) {
  return String(
    value?._serialized
    || value?.id?._serialized
    || value?.id
    || value?.chatId
    || value
    || '',
  ).trim();
}

function extractLabelUpdateChatId(data = {}) {
  const candidates = [
    data?.chat?.id?._serialized,
    data?.chat?.id,
    data?.chat?.chatId,
    data?.chatId,
    typeof data?.chat === 'string' ? data.chat : '',
  ];
  return candidates.map(serializedId).find(Boolean) || '';
}

function labelNamesFromUpdate(data = {}) {
  const labels = Array.isArray(data?.labels) ? data.labels : Object.values(data?.labels || {});
  return labels
    .map((label) => String(label?.name || label?.label || '').trim())
    .filter(Boolean);
}

function normalizeName(value) {
  return LabelPolicy.normalizeName(value);
}

function operationalLabelNames() {
  return LabelPolicy.operationalLabelNames();
}

function sellerFromEventNames(names = []) {
  for (const name of names) {
    const classification = LabelPolicy.classifyLabel(name);
    if (classification.category === LabelPolicy.LABEL_CATEGORY.SELLER) {
      return { seller: classification.seller, labelName: classification.name };
    }
  }
  return null;
}

function firstManualLabelName(names = []) {
  for (const name of names) {
    const classification = LabelPolicy.classifyLabel(name);
    if (classification.category === LabelPolicy.LABEL_CATEGORY.MANUAL) return classification.name;
  }
  return null;
}

function firstBlockingEventLabel(names = []) {
  for (const name of names) {
    const classification = LabelPolicy.classifyLabel(name);
    if (classification.blocks) return classification;
  }
  return null;
}

function existingSessionFor(clientId) {
  const candidates = new Set();
  try {
    candidates.add(Store.normalizeClientId(clientId));
    for (const alias of Identity.getLabelCandidateIds(clientId)) {
      candidates.add(Store.normalizeClientId(alias));
    }
  } catch (_) {}

  return Store.listSessions().find((session) => {
    const id = session?.chatId || session?.clientId || session?.id;
    return candidates.has(Store.normalizeClientId(id));
  }) || null;
}

function persistSellerStatus(clientId, payload = {}) {
  const session = existingSessionFor(clientId);
  if (!session) return false;

  const data = session.dados || (session.dados = {});
  const previous = data.sellerHandoff || {};
  data.sellerHandoff = {
    ...previous,
    status: payload.status || previous.status || null,
    seller: payload.seller ?? previous.seller ?? null,
    labelName: payload.labelName ?? previous.labelName ?? null,
    assignedAt: payload.assignedAt ?? previous.assignedAt ?? null,
    releasedAt: payload.releasedAt ?? previous.releasedAt ?? null,
    lastLabelEventAt: new Date().toISOString(),
  };
  Store.saveSession(session);
  return true;
}

function createSellerLabelUpdateHandler(options = {}) {
  const getChannel = options.getChannel || (() => null);
  const clearBuffer = options.clearBuffer || (() => {});
  const delayMs = Math.max(0, Number(options.delayMs ?? 500));
  const seen = new Map();

  return async function handleSellerLabelUpdate(payload = {}) {
    const data = payload?.data || payload || {};
    const channel = payload?.channel || getChannel();
    const chatId = extractLabelUpdateChatId(data);
    const type = String(data?.type || 'update').trim().toLowerCase();
    const names = labelNamesFromUpdate(data);

    if (!chatId) {
      console.warn(`[ETIQUETAS][EVENTO] atualização sem chat identificável | tipo=${type} | etiquetas=${names.join(', ') || '-'}`);
      return { handled: false, reason: 'CHAT_ID_UNAVAILABLE' };
    }

    if (channel?.__isInternalLabelOperation?.(chatId)) {
      console.log(`[ETIQUETAS][EVENTO] alteração interna ignorada | cliente=${chatId} | tipo=${type} | etiquetas=${names.join(', ') || '-'}`);
      return { handled: false, reason: 'INTERNAL_OPERATION', chatId };
    }

    const eventLabel = type === 'add' ? firstBlockingEventLabel(names) : null;
    if (eventLabel) {
      const key = `${chatId}:${eventLabel.reason}:${eventLabel.normalized}`;
      const now = Date.now();
      const duplicate = Number(seen.get(key) || 0) > (now - 15000);
      seen.set(key, now);

      HumanControl.setBlock(chatId, {
        reason: eventLabel.reason,
        source: `${eventLabel.reason}_event`,
        seller: eventLabel.seller,
        labelName: eventLabel.name,
        persistent: true,
        blockedHours: env.humanBlockHours,
      });

      persistSellerStatus(chatId, {
        status: 'assigned',
        seller: eventLabel.seller,
        labelName: eventLabel.name,
        assignedAt: new Date().toISOString(),
        releasedAt: null,
      });
      clearBuffer(chatId);

      if (!duplicate) {
        const session = existingSessionFor(chatId);
        const phase = session?.completed || session?.dados?.botDone ? 'concluído' : 'em_andamento';
        console.log(
          `[HANDOFF][ETIQUETA] cliente bloqueado pelo evento real | cliente=${chatId} `
          + `| motivo=${eventLabel.reason} | vendedor=${eventLabel.seller || '-'} `
          + `| etiqueta="${eventLabel.name}" | préAtendimento=${phase}`,
        );
      }

      return {
        handled: true,
        assigned: true,
        blocked: true,
        chatId,
        guard: {
          blocked: true,
          reason: eventLabel.reason,
          seller: eventLabel.seller,
          labelName: eventLabel.name,
          source: `${eventLabel.reason}_event`,
        },
      };
    }

    if (type === 'add' && names.length && names.every((name) => !LabelPolicy.classifyLabel(name).blocks)) {
      console.log(`[ETIQUETAS][EVENTO] etiqueta operacional ignorada | cliente=${chatId} | etiquetas=${names.join(', ')}`);
      return { handled: true, assigned: false, blocked: false, operational: true, chatId };
    }

    if (delayMs) await wait(delayMs);

    const guard = await SellerHandoff.getAutomationBlock(channel, chatId);
    if (guard?.blocked) {
      const removed = type === 'remove';
      persistSellerStatus(chatId, {
        status: 'assigned',
        seller: guard.seller || null,
        labelName: guard.labelName || null,
        assignedAt: new Date().toISOString(),
        releasedAt: null,
      });
      clearBuffer(chatId);

      if (removed) {
        console.log(
          `[HANDOFF] etiqueta removida; bloqueio persistente mantido | cliente=${chatId} `
          + `| motivo=${guard.reason || '-'} | etiqueta="${guard.labelName || names.join(', ') || '-'}"`,
        );
      }

      return {
        handled: true,
        assigned: true,
        blocked: true,
        removed,
        released: false,
        chatId,
        guard,
      };
    }

    console.log(
      `[ETIQUETAS][EVENTO] alteração externa sem bloqueio ativo | cliente=${chatId} `
      + `| tipo=${type} | etiquetas=${names.join(', ') || '-'}`,
    );
    return { handled: true, assigned: false, blocked: false, chatId, guard };
  };
}

module.exports = {
  createSellerLabelUpdateHandler,
  existingSessionFor,
  extractLabelUpdateChatId,
  firstBlockingEventLabel,
  firstManualLabelName,
  labelNamesFromUpdate,
  normalizeName,
  operationalLabelNames,
  sellerFromEventNames,
  persistSellerStatus,
  serializedId,
};
