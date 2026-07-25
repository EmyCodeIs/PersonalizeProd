'use strict';

const WppClient = require('../services/wppconnectClient');
const HumanControl = require('../services/humanControlStore');
const Identity = require('../services/contactIdentity');
const ResetStore = require('../services/handoffResetStore');
const SellerHandoff = require('./sellerHandoff');
const SellerEvents = require('./sellerLabelEvents');
const SellerAlias = require('./sellerAliasHandoffPreload');
const TesterRuntime = require('./testerRuntime');
const RuntimeReliability = require('./runtimeReliabilityPreload');
const { OutboundTracker } = require('./outboundTracker');
const { decision, decisionError } = require('./decisionLogger');
const {
  candidateIds,
  classifyLabelNames,
  isStrictTesterIdentity,
  isSupportedHandoffReason,
} = require('./handoffPolicy');

const LABEL_CACHE_TTL_MS = 1200;
const labelInspectionCache = new Map();
const previousGetAutomationBlock = SellerHandoff.getAutomationBlock.bind(SellerHandoff);

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms || 0))));
}

function contactKey(clientId) {
  try { return String(Identity.getSessionKey(clientId) || clientId || '').trim(); } catch (_) { return String(clientId || '').trim(); }
}

function invalidateLabelInspection(clientId) {
  labelInspectionCache.delete(contactKey(clientId));
}

function clearHumanBlocks(clientId) {
  let cleared = 0;
  for (const candidate of candidateIds(clientId)) {
    try { if (HumanControl.clearBlock(candidate)) cleared += 1; } catch (_) {}
  }
  return cleared;
}

function clearContactRuntime(clientId, code = 'HUMAN_HANDOFF') {
  const ids = candidateIds(clientId);
  const runtime = TesterRuntime?._test?.runtime || {};
  let discardedBuffers = 0;
  let cancelledTasks = 0;

  for (const buffer of runtime.buffers || []) {
    for (const id of ids) discardedBuffers += Number(buffer?.clear?.(id) || 0);
  }
  for (const queue of runtime.queues || []) {
    cancelledTasks += Number(queue?.cancelQueuedForChats?.(ids, code) || 0);
  }

  if (discardedBuffers) {
    decision('BUFFER', 'descartado_por_handoff', {
      chat: clientId,
      quantidade: discardedBuffers,
      motivo: code.toLowerCase(),
    });
  }
  if (cancelledTasks) {
    decision('FILA', 'cancelada_por_handoff', {
      chat: clientId,
      quantidade: cancelledTasks,
      motivo: code.toLowerCase(),
    });
  }
  return { ids, discardedBuffers, cancelledTasks };
}

function currentBlock(clientId) {
  try { return HumanControl.getBlock(clientId); } catch (_) { return { blocked: false, control: null }; }
}

function activateHandoff(clientId, payload = {}) {
  const reason = String(payload.reason || '').trim();
  if (isStrictTesterIdentity({ from: clientId })) {
    const cleared = clearHumanBlocks(clientId);
    return { blocked: false, bypassed: true, reason: 'tester_identity', cleared };
  }
  if (!isSupportedHandoffReason(reason)) {
    decision('HANDOFF', 'candidato_ignorado', {
      chat: clientId,
      status: 'livre',
      motivo: reason || 'reason_unavailable',
    });
    return { blocked: false, ignored: true, reason: 'unsupported_handoff_reason' };
  }

  const existing = currentBlock(clientId);
  const same = existing?.blocked
    && String(existing.control?.reason || '') === reason
    && String(existing.control?.labelName || '') === String(payload.labelName || '');

  if (!same) {
    HumanControl.setBlock(clientId, {
      reason,
      source: payload.source || reason,
      seller: payload.seller || null,
      labelName: payload.labelName || null,
      persistent: true,
    });
  }

  const runtime = clearContactRuntime(clientId, 'HUMAN_HANDOFF');
  decision('HANDOFF', 'ativado', {
    chat: clientId,
    status: 'bloqueado',
    motivo: reason,
    vendedor: payload.seller || '-',
    etiqueta: payload.labelName || '-',
    origem: payload.source || reason,
  });
  return {
    blocked: true,
    reason,
    seller: payload.seller || null,
    labelName: payload.labelName || null,
    source: payload.source || reason,
    runtime,
  };
}

async function inspectExternalLabels(channel, clientId, { force = false } = {}) {
  const key = contactKey(clientId);
  const cached = labelInspectionCache.get(key);
  if (!force && cached && (Date.now() - cached.at) <= LABEL_CACHE_TTL_MS) return cached.value;

  const inspectChatLabels = SellerHandoff?._test?.inspectChatLabels;
  if (typeof inspectChatLabels !== 'function' || !channel?.client) {
    return { assigned: false, conclusive: false, reason: 'label_inspection_unavailable', candidates: [] };
  }

  let resolution;
  try {
    resolution = typeof SellerAlias.resolveSellerLabelCandidates === 'function'
      ? await SellerAlias.resolveSellerLabelCandidates(channel, clientId)
      : { direct: Identity.normalizeChatId(clientId), candidates: candidateIds(clientId), conclusiveIdentity: true };
  } catch (_) {
    resolution = { direct: Identity.normalizeChatId(clientId), candidates: candidateIds(clientId), conclusiveIdentity: false };
  }

  let inspectionAvailable = false;
  let chatFound = false;
  let inspectedPhoneAlias = false;
  const inspected = [];

  for (const chatId of resolution.candidates || candidateIds(clientId)) {
    const inspection = await inspectChatLabels(channel.client, chatId);
    if (inspection?.available) inspectionAvailable = true;
    if (inspection?.chatFound) chatFound = true;
    if (chatId.endsWith('@c.us') && inspection?.available && inspection?.chatFound) inspectedPhoneAlias = true;

    const classification = classifyLabelNames(inspection?.items || []);
    inspected.push({ chatId, available: inspection?.available, chatFound: inspection?.chatFound, classification });
    if (classification.assigned) {
      const value = {
        ...classification,
        chatId,
        source: 'attached_label',
        conclusive: true,
        inspectionAvailable,
        chatFound,
        inspected,
      };
      labelInspectionCache.set(key, { at: Date.now(), value });
      return value;
    }
  }

  const direct = String(resolution.direct || Identity.normalizeChatId(clientId) || '');
  const conclusive = Boolean(
    inspectionAvailable
    && chatFound
    && resolution.conclusiveIdentity !== false
    && (!direct.endsWith('@lid') || inspectedPhoneAlias),
  );
  const value = {
    assigned: false,
    conclusive,
    reason: conclusive ? 'no_external_label' : 'label_inspection_inconclusive',
    inspectionAvailable,
    chatFound,
    inspected,
  };
  labelInspectionCache.set(key, { at: Date.now(), value });
  return value;
}

async function getAutomationBlock(channel, clientId) {
  if (isStrictTesterIdentity({ from: clientId })) {
    const cleared = clearHumanBlocks(clientId);
    invalidateLabelInspection(clientId);
    return { blocked: false, reason: null, source: 'tester_identity', cleared };
  }

  let existing = currentBlock(clientId);
  const existingReason = String(existing?.control?.reason || '');
  if (existing?.blocked && !isSupportedHandoffReason(existingReason)) {
    HumanControl.clearBlock(clientId);
    decision('HANDOFF', 'bloqueio_legado_invalido_removido', {
      chat: clientId,
      status: 'livre',
      motivo: existingReason || 'sem_motivo',
    });
    existing = { blocked: false, control: null };
  }

  if (existing?.blocked && ['seller_label', 'manual_label'].includes(existingReason)) {
    const storedLabel = String(existing.control?.labelName || '').trim();
    const storedClassification = classifyLabelNames(storedLabel ? [storedLabel] : []);
    if (!storedClassification.assigned) {
      HumanControl.clearBlock(clientId);
      decision('HANDOFF', 'bloqueio_de_etiqueta_sem_evidência_removido', {
        chat: clientId,
        status: 'livre',
        motivo: storedLabel ? storedClassification.reason : 'label_name_missing',
        etiqueta: storedLabel || '-',
      });
      existing = { blocked: false, control: null };
    }
  }

  if (existing?.blocked && ['manual_outbound_message', 'manual_outbound_history'].includes(existingReason)) {
    return {
      blocked: true,
      reason: existingReason,
      seller: existing.control?.seller || null,
      labelName: existing.control?.labelName || null,
      source: existing.control?.source || 'human_control',
      details: existing.control,
    };
  }

  const labels = await inspectExternalLabels(channel, clientId);
  if (labels.assigned) {
    return activateHandoff(clientId, {
      reason: labels.reason,
      seller: labels.seller,
      labelName: labels.labelName,
      source: 'attached_label',
    });
  }

  if (existing?.blocked && ['seller_label', 'manual_label'].includes(existingReason)) {
    if (labels.conclusive) {
      HumanControl.clearBlock(clientId);
      decision('HANDOFF', 'liberado_por_ausência_de_etiqueta_externa', {
        chat: clientId,
        status: 'livre',
        motivo: existingReason,
      });
      return { blocked: false, reason: null, source: 'external_label_removed' };
    }
    return {
      blocked: true,
      reason: existingReason,
      seller: existing.control?.seller || null,
      labelName: existing.control?.labelName || null,
      source: existing.control?.source || 'human_control',
      details: { ...existing.control, labelInspection: labels },
    };
  }

  try {
    const historical = await previousGetAutomationBlock(channel, clientId);
    if (historical?.blocked && historical.reason === 'manual_outbound_history') {
      return activateHandoff(clientId, {
        reason: 'manual_outbound_history',
        source: historical.source || 'history_guard',
      });
    }
  } catch (error) {
    decisionError('verificação_histórica_de_handoff_falhou', error, { chat: clientId });
  }

  return { blocked: false, reason: null, source: labels.reason };
}

function registerManualTakeover(clientId, payload = {}) {
  return activateHandoff(clientId, {
    ...payload,
    reason: 'manual_outbound_message',
    source: payload.source || 'manual_outbound_message',
  });
}

function installCentralHandoffPolicy() {
  SellerHandoff.getAutomationBlock = getAutomationBlock;
  SellerHandoff.registerManualTakeover = registerManualTakeover;
  SellerHandoff.detectSellerLabelAssignment = async (channel, clientId) => inspectExternalLabels(channel, clientId, { force: true });
  SellerHandoff.__centralHandoffPolicyInstalled = true;
}

function installAliasAwareOutboundTracking() {
  if (OutboundTracker.prototype.__aliasAwareHandoffInstalled) return;
  const originalConsume = OutboundTracker.prototype.consumeIfBot;
  OutboundTracker.prototype.consumeIfBot = function consumeBotAcrossAliases(chatId, message = {}) {
    for (const candidate of candidateIds(chatId)) {
      const matched = originalConsume.call(this, candidate, message);
      if (matched) return matched;
    }
    return originalConsume.call(this, chatId, message);
  };
  OutboundTracker.prototype.__aliasAwareHandoffInstalled = true;
}

function handoffBlockedError(clientId, guard, operation) {
  const error = new Error(`Envio bloqueado por handoff humano: ${guard?.reason || 'human_handoff'}.`);
  error.code = 'HUMAN_HANDOFF_BLOCKED';
  error.chatId = clientId;
  error.reason = guard?.reason || 'human_handoff';
  error.operation = operation;
  return error;
}

async function assertCanSend(channel, clientId, operation) {
  const guard = await getAutomationBlock(channel, clientId);
  if (!guard?.blocked) return guard;
  decision('ENVIO', 'bloqueado_antes_do_transporte', {
    chat: clientId,
    status: 'bloqueado',
    motivo: guard.reason,
    tipo: operation,
  }, 'warn');
  throw handoffBlockedError(clientId, guard, operation);
}

function wrapChannelSendGuard(channel, methodName, operation) {
  if (!channel || typeof channel[methodName] !== 'function') return;
  const marker = `__handoffGuard_${methodName}`;
  if (channel[marker]) return;
  const original = channel[methodName].bind(channel);
  channel[methodName] = async (clientId, ...args) => {
    await assertCanSend(channel, clientId, operation);
    return original(clientId, ...args);
  };
  channel[marker] = true;
}

function wrapTrackedListMethod(channel, methodName, describe) {
  const client = channel?.client;
  if (!client || typeof client[methodName] !== 'function') return;
  const marker = `__handoffTracked_${methodName}`;
  if (client[marker]) return;
  const original = client[methodName].bind(client);

  client[methodName] = async (chatId, ...args) => {
    await assertCanSend(channel, chatId, 'lista');
    const details = describe(args);
    const pending = channel.outboundTracker?.register?.(chatId, {
      type: 'list',
      text: details.text || '',
    }) || null;
    try {
      const result = await original(chatId, ...args);
      channel.outboundTracker?.confirm?.(pending, result);
      return result;
    } catch (error) {
      channel.outboundTracker?.fail?.(pending);
      throw error;
    }
  };
  client[marker] = true;
}

function installTransportSafety() {
  if (WppClient.__handoffTransportSafetyInstalled) return;
  const originalCreateWppChannel = WppClient.createWppChannel;

  WppClient.createWppChannel = async function createChannelWithHandoffTransportSafety(options = {}) {
    const channel = await originalCreateWppChannel(options);
    for (const [method, operation] of [
      ['sendText', 'texto'],
      ['sendImage', 'imagem'],
      ['sendDocument', 'documento'],
      ['sendCatalog', 'catálogo'],
    ]) wrapChannelSendGuard(channel, method, operation);

    wrapTrackedListMethod(channel, 'sendListMessage', ([payload]) => ({
      text: String(payload?.title || payload?.description || '').trim(),
    }));
    wrapTrackedListMethod(channel, 'sendList', ([description, buttonText]) => ({
      text: String(description || buttonText || '').trim(),
    }));

    channel.__assertHandoffAllowsSend = (clientId, operation = 'envio') => assertCanSend(channel, clientId, operation);
    return channel;
  };
  WppClient.__handoffTransportSafetyInstalled = true;
}

function installStrictLabelEvents() {
  SellerEvents.createSellerLabelUpdateHandler = function createStrictLabelUpdateHandler(options = {}) {
    const getChannel = options.getChannel || (() => null);
    const delayMs = Math.max(0, Number(options.delayMs ?? 500));

    return async function handleStrictLabelUpdate(payload = {}) {
      const data = payload?.data || payload || {};
      const channel = payload?.channel || getChannel();
      const chatId = SellerEvents.extractLabelUpdateChatId(data);
      const type = String(data?.type || 'update').trim().toLowerCase();
      const names = SellerEvents.labelNamesFromUpdate(data);

      if (!chatId) return { handled: false, reason: 'CHAT_ID_UNAVAILABLE' };
      if (isStrictTesterIdentity({ from: chatId })) {
        clearHumanBlocks(chatId);
        return { handled: false, reason: 'TESTER_IDENTITY', chatId };
      }
      if (channel?.__isInternalLabelOperation?.(chatId)) {
        return { handled: false, reason: 'INTERNAL_OPERATION', chatId };
      }

      const eventClassification = classifyLabelNames(names);
      if (type === 'add' && eventClassification.assigned) {
        invalidateLabelInspection(chatId);
        const guard = activateHandoff(chatId, {
          reason: eventClassification.reason,
          seller: eventClassification.seller,
          labelName: eventClassification.labelName,
          source: 'external_label_event',
        });
        SellerEvents.persistSellerStatus(chatId, {
          status: 'assigned',
          seller: guard.seller,
          labelName: guard.labelName,
          assignedAt: new Date().toISOString(),
          releasedAt: null,
        });
        return { handled: true, assigned: true, chatId, guard };
      }

      if (type === 'add' && names.length && eventClassification.reason === 'managed_service_labels_only') {
        decision('ETIQUETA', 'serviço_nativo_ignorado_para_handoff', {
          chat: chatId,
          etiqueta: names.join(', '),
          status: 'livre',
        });
        return { handled: false, assigned: false, reason: 'MANAGED_SERVICE_LABEL', chatId };
      }

      if (delayMs) await wait(delayMs);
      invalidateLabelInspection(chatId);
      const guard = await getAutomationBlock(channel, chatId);
      if (guard?.blocked && ['seller_label', 'manual_label'].includes(guard.reason)) {
        SellerEvents.persistSellerStatus(chatId, {
          status: 'assigned',
          seller: guard.seller || null,
          labelName: guard.labelName || null,
          assignedAt: new Date().toISOString(),
          releasedAt: null,
        });
        return { handled: true, assigned: true, chatId, guard };
      }

      if (!guard?.blocked && ['remove', 'delete', 'update'].includes(type)) {
        SellerEvents.persistSellerStatus(chatId, { status: 'released', releasedAt: new Date().toISOString() });
      }
      return {
        handled: true,
        assigned: false,
        chatId,
        guard,
        reason: names.length ? 'NO_EXTERNAL_LABEL' : 'INCOMPLETE_LABEL_EVENT',
      };
    };
  };
}

function installTesterResetBoundary() {
  if (TesterRuntime.__handoffResetBoundaryInstalled) return;
  const originalClear = TesterRuntime.clearTesterConversationRuntime.bind(TesterRuntime);
  TesterRuntime.clearTesterConversationRuntime = function clearTesterWithHistoryBoundary(clientId, ...args) {
    const result = originalClear(clientId, ...args);
    const checkpoint = ResetStore.markReset(clientId, { reason: 'resetarsys' });
    RuntimeReliability.clearHistoricalHumanGuardCache?.(clientId);
    invalidateLabelInspection(clientId);
    decision('ADMIN', 'resetarsys_marco_de_histórico', {
      chat: clientId,
      resultado: checkpoint ? 'ok' : 'falhou',
      data: checkpoint?.at || '-',
    });
    return { ...result, handoffResetCheckpoint: checkpoint };
  };
  TesterRuntime.__handoffResetBoundaryInstalled = true;
}

installAliasAwareOutboundTracking();
installCentralHandoffPolicy();
installStrictLabelEvents();
installTesterResetBoundary();
installTransportSafety();

module.exports = {
  activateHandoff,
  assertCanSend,
  clearContactRuntime,
  getAutomationBlock,
  inspectExternalLabels,
  invalidateLabelInspection,
  registerManualTakeover,
  _test: {
    labelInspectionCache,
    handoffBlockedError,
  },
};
