'use strict';

const WppClient = require('../services/wppconnectClient');
const Inbox = require('../services/messageInboxStore');
const Cursor = require('../services/conversationCursorStore');
const Recovery = require('../services/conversationRecovery');
const LeadReport = require('../services/leadAbandonmentReport');
const LeadNotifications = require('../services/leadNotificationService');
const LeadOperations = require('../services/leadOperationStore');
const ResetCheckpoint = require('../services/resetCheckpointStore');
const Store = require('../services/leadStore');
const { getAutomationBlock } = require('./sellerHandoff');
const { recoveryConfig } = require('../config/recoveryConfig');
const { leadOperationsConfig } = require('../config/leadOperationsConfig');

let activeChannel = null;
let alertRunning = false;
const originalListSessions = Store.listSessions.bind(Store);

function sessionMap() {
  const map = new Map();
  for (const session of originalListSessions()) {
    const clientId = session.chatId || session.clientId || session.id;
    if (!clientId) continue;
    map.set(Store.normalizeClientId(clientId), session);
  }
  return map;
}

function sessionForRecord(record, sessions) {
  const clientId = record?.conversationId || record?.from;
  if (!clientId) return null;
  return sessions.get(Store.normalizeClientId(clientId)) || null;
}

function updateCursorFromRecords(records = [], outcome = 'PROCESSED') {
  const sessions = sessionMap();
  const ordered = [...records].sort((a, b) => (
    Cursor.messageMeta(a).at - Cursor.messageMeta(b).at
  ));
  for (const record of ordered) {
    const clientId = record?.conversationId || record?.from;
    if (!clientId) continue;
    Cursor.markProcessed(clientId, record, {
      outcome,
      session: sessionForRecord(record, sessions),
    });
  }
}

function patchInboxLifecycle() {
  if (Inbox.__conversationCursorLifecyclePatched) return;

  const originalReceive = Inbox.receive.bind(Inbox);
  const originalMarkProcessed = Inbox.markProcessed.bind(Inbox);
  const originalMarkIgnored = Inbox.markIgnored.bind(Inbox);
  const originalMarkFailure = Inbox.markFailure.bind(Inbox);
  const originalMarkReset = Inbox.markResetForConversation.bind(Inbox);

  Inbox.receive = function receiveWithConversationCursor(payload = {}) {
    const result = originalReceive(payload);
    const record = result?.record;
    const clientId = record?.conversationId || record?.from || payload.conversationId || payload.from;
    if (clientId && record) Cursor.observeReceived(clientId, record);
    return result;
  };

  Inbox.markProcessed = function markProcessedWithConversationCursor(ids, payload = {}) {
    const result = originalMarkProcessed(ids, payload);
    updateCursorFromRecords(result, payload.reason || 'PROCESSED');
    return result;
  };

  Inbox.markIgnored = function markIgnoredWithConversationCursor(ids, status, payload = {}) {
    const result = originalMarkIgnored(ids, status, payload);
    updateCursorFromRecords(result, status || 'IGNORED');
    if (status === Inbox.STATUS.IGNORED_HANDOFF) {
      for (const record of result) {
        const clientId = record?.conversationId || record?.from;
        if (clientId) Cursor.markLifecycle(clientId, 'HANDOFF', { reason: payload.reason || 'human_block' });
      }
    }
    return result;
  };

  Inbox.markFailure = function markFailureWithConversationCursor(ids, error, options = {}) {
    const result = originalMarkFailure(ids, error, options);
    const terminal = result.filter((record) => record.status === Inbox.STATUS.FAILED_FINAL);
    if (terminal.length) updateCursorFromRecords(terminal, 'FAILED_FINAL');
    return result;
  };

  Inbox.markResetForConversation = function markResetWithConversationCursor(clientId, aliases = [], options = {}) {
    const result = originalMarkReset(clientId, aliases, options);
    const checkpoint = ResetCheckpoint.getLastReset(clientId);
    Cursor.markReset(clientId, {
      at: checkpoint?.at || options.now || new Date().toISOString(),
      generation: checkpoint?.generation || null,
      messageId: checkpoint?.messageId || null,
    });
    return result;
  };

  Inbox.__conversationCursorLifecyclePatched = true;
}

function patchLegacySingleMessageRecovery() {
  if (Store.__cursorLegacyRecoveryBridgeInstalled) return;
  Store.listSessions = function listSessionsWithLegacyRecoveryBridge(...args) {
    const stack = String(new Error().stack || '');
    if (stack.includes('activeRecoverySessions') || stack.includes('recoverPendingActiveSessions')) {
      console.log('[CURSOR] recuperação legada de uma única mensagem ignorada; cursor persistente é a fonte oficial.');
      return [];
    }
    return originalListSessions(...args);
  };
  Store.__cursorLegacyRecoveryBridgeInstalled = true;
}

async function runAlertCycle(reason = 'scheduled') {
  if (alertRunning || !activeChannel) return { skipped: true, reason: alertRunning ? 'RUNNING' : 'CHANNEL_UNAVAILABLE' };
  alertRunning = true;
  try {
    const result = await LeadNotifications.runLeadAlerts(activeChannel);
    if (result.eligible || result.sent || result.failed) {
      console.log(
        `[LEADS 24H] rodada ${reason} | elegíveis=${result.eligible || 0} `
        + `| enviados=${result.sent || 0} | painel=${result.panelPending || 0} | falhas=${result.failed || 0}`,
      );
    }
    return result;
  } finally {
    alertRunning = false;
  }
}

function startLifecycleMonitor() {
  if (global.__personalizeLeadLifecycleTimer) return global.__personalizeLeadLifecycleTimer;
  const timer = setInterval(() => {
    try {
      const summary = LeadReport.refreshLifecycle();
      if (summary.abandoned || summary.expired) {
        console.log(
          `[LEADS 24H] ciclo atualizado | parados=${summary.abandoned} | expirados=${summary.expired}`,
        );
      }
      Cursor.purge({ ttlDays: recoveryConfig.cursorTtlDays });
      LeadOperations.purge({ ttlDays: leadOperationsConfig.operationTtlDays });
      void runAlertCycle('interval').catch((error) => {
        console.warn('[LEADS 24H] falha na entrega automática:', error?.message || error);
      });
    } catch (error) {
      console.warn('[LEADS 24H] falha ao atualizar ciclo:', error?.message || error);
    }
  }, Math.min(recoveryConfig.lifecycleRefreshMs, leadOperationsConfig.alertIntervalMs));
  timer.unref?.();
  global.__personalizeLeadLifecycleTimer = timer;
  return timer;
}

function attachChannelTools(channel) {
  global.__personalizeActiveChannel = channel;
  try { require('../services/qrAdminServer').setQrAdminChannel(channel); } catch (_) {}
  channel.__runConversationCursorRecovery = async (reason = 'manual') => {
    const staged = await Recovery.stageUnreadMessages({ channel });
    const recovered = await Recovery.recoverStaged(channel, `cursor-${reason}`);
    LeadReport.refreshLifecycle();
    return { staged, recovered };
  };
  channel.__conversationCursorStats = () => Cursor.stats();
  channel.__leadAbandonmentReport = (options = {}) => LeadReport.buildReport(options);
  channel.__writeLeadAbandonmentReport = (options = {}) => LeadReport.writeTxtReport(options);
  channel.__markLeadNotified = (conversationKey, payload = {}) => LeadReport.markNotified(conversationKey, payload);
  channel.__runLeadAlerts = (reason = 'manual') => runAlertCycle(reason);
  channel.__updateLeadOperation = (payload = {}) => LeadOperations.updateStatus(payload);
  channel.__leadOperationStats = () => LeadOperations.stats();
}

function installConversationRecovery() {
  patchInboxLifecycle();
  patchLegacySingleMessageRecovery();
  if (WppClient.__conversationCursorRecoveryInstalled) return WppClient;

  const originalCreateWppChannel = WppClient.createWppChannel.bind(WppClient);
  const originalCollectUnreadMessages = WppClient.collectUnreadMessages.bind(WppClient);

  WppClient.collectUnreadMessages = async function collectUnreadThroughCursor(client) {
    if (!recoveryConfig.enabled) return originalCollectUnreadMessages(client);
    if (!activeChannel || activeChannel.client !== client) return originalCollectUnreadMessages(client);
    if (typeof activeChannel.isConnectionReady === 'function' && !activeChannel.isConnectionReady()) {
      console.log('[CURSOR] não lidas aguardando conexão READY.');
      return [];
    }

    const staged = await Recovery.stageUnreadMessages({ channel: activeChannel, client });
    const recovered = await Recovery.recoverStaged(activeChannel, 'cursor-unread');
    console.log(
      `[CURSOR] não lidas unificadas | conversas=${staged.conversations} | elegíveis=${staged.eligible} `
      + `| persistidas=${staged.staged} | reenviadas=${recovered.replayed}`,
    );
    LeadReport.refreshLifecycle();
    return [];
  };

  WppClient.createWppChannel = async function createWppChannelWithConversationCursor(options = {}) {
    const channel = await originalCreateWppChannel(options);
    activeChannel = channel;
    attachChannelTools(channel);
    startLifecycleMonitor();

    if (!recoveryConfig.enabled) return channel;

    const staged = await Recovery.stageActiveSessions({
      channel,
      sessions: originalListSessions(),
      canRecover: async (clientId) => getAutomationBlock(channel, clientId),
    });
    const recovered = await Recovery.recoverStaged(channel, 'cursor-active-sessions');
    const lifecycle = LeadReport.refreshLifecycle();
    console.log(
      `[CURSOR] retomada ativa concluída | conversas=${staged.conversations} | elegíveis=${staged.eligible} `
      + `| persistidas=${staged.staged} | reenviadas=${recovered.replayed} `
      + `| leads24h=${lifecycle.abandoned + lifecycle.expired}`,
    );

    const initialAlertTimer = setTimeout(() => {
      void runAlertCycle('startup').catch((error) => {
        console.warn('[LEADS 24H] falha na rodada inicial:', error?.message || error);
      });
    }, 5000);
    initialAlertTimer.unref?.();
    return channel;
  };

  WppClient.__conversationCursorRecoveryInstalled = true;
  return WppClient;
}

installConversationRecovery();

module.exports = {
  attachChannelTools,
  installConversationRecovery,
  patchInboxLifecycle,
  patchLegacySingleMessageRecovery,
  runAlertCycle,
  startLifecycleMonitor,
  _test: {
    originalListSessions,
    sessionForRecord,
    updateCursorFromRecords,
  },
};
