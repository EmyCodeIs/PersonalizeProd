'use strict';

const WppClient = require('../services/wppconnectClient');
const SellerHandoff = require('./sellerHandoff');
const TesterRuntime = require('./testerRuntime');
const Synchronization = require('./synchronizationGuardPreload');
const { decision } = require('./decisionLogger');
const Access = require('./testCommandAccess');

function textFromPayload(payload = {}) {
  return String(payload.text || payload?.raw?.body || payload?.raw?.caption || payload?.raw?.text || '').trim();
}

function isResetCommand(payload = {}) {
  return textFromPayload(payload).split(/\r?\n/)[0].trim().toLowerCase() === '/resetarsys';
}

async function waitForOperationalConnection(channel, options = {}) {
  const result = await Synchronization.waitForOperationalConnection(channel, options);
  if (result?.ready) return result.state;
  const error = new Error(result?.reason || 'WPP_CONNECTION_TIMEOUT');
  error.code = result?.reason || 'WPP_CONNECTION_TIMEOUT';
  error.readiness = result;
  throw error;
}

function installIsolatedTesterCompatibility() {
  // Na inicialização real, handoffSafetyPreload já instalou a política central.
  // Este fallback existe somente para consumidores/testes que carregam este
  // preload isoladamente e nunca substitui a política final de produção.
  if (SellerHandoff.__centralHandoffPolicyInstalled || SellerHandoff.__isolatedTesterCompatibilityInstalled) return;

  const originalGetAutomationBlock = SellerHandoff.getAutomationBlock.bind(SellerHandoff);
  const originalRegisterManualTakeover = SellerHandoff.registerManualTakeover.bind(SellerHandoff);

  SellerHandoff.getAutomationBlock = async function getAutomationBlockWithIsolatedTesterCompatibility(channel, clientId) {
    if (Access.isTesterIdentity({ from: clientId })) {
      const cleared = TesterRuntime.clearHumanBlocks(clientId);
      return { blocked: false, reason: null, source: 'tester_identity', cleared };
    }
    return originalGetAutomationBlock(channel, clientId);
  };

  SellerHandoff.registerManualTakeover = function registerManualTakeoverWithIsolatedTesterCompatibility(clientId, payload = {}) {
    if (Access.isTesterIdentity({ from: clientId })) {
      const cleared = TesterRuntime.clearHumanBlocks(clientId);
      return { bypassed: true, blocked: false, reason: 'tester_identity', cleared };
    }
    return originalRegisterManualTakeover(clientId, payload);
  };

  SellerHandoff.__isolatedTesterCompatibilityInstalled = true;
}

function installTesterHandoffBypass() {
  if (SellerHandoff.__testerHandoffBypassInstalled) return;

  installIsolatedTesterCompatibility();

  const originalCreateWppChannel = WppClient.createWppChannel;
  WppClient.createWppChannel = async function createWppChannelWithTesterReset(options = {}) {
    const originalOnMessage = options.onMessage;
    let channelRef = null;

    const onMessage = async (payload = {}) => {
      if (!isResetCommand(payload)) {
        return typeof originalOnMessage === 'function' ? originalOnMessage(payload) : undefined;
      }

      const access = Access.isTestCommandAuthorized({ from: payload.from, raw: payload.raw });
      if (!access.allowed) {
        decision('ADMIN', 'resetarsys_negado', { chat: payload.from || '-', motivo: access.reason }, 'warn');
        return undefined;
      }

      const cleanup = TesterRuntime.clearTesterConversationRuntime(payload.from);
      decision('ADMIN', 'resetarsys_limpeza_local', {
        chat: payload.from,
        resultado: 'ok',
        buffers: cleanup.discardedBuffers,
        tarefas: cleanup.cancelledTasks,
        bloqueios: cleanup.blocksCleared,
        atividade_bot: cleanup.activityCleared,
        sessão_removida: Boolean(cleanup.reset?.sessionRemoved),
        perfil_removido: Boolean(cleanup.reset?.profileRemoved),
      });

      await channelRef?.sendText?.(
        payload.from,
        'Sistema resetado para teste.\n\nConversa zerada para teste. Envie uma nova mensagem para começar como primeiro contato.',
        { noDelay: true, noTyping: true },
      );
      return undefined;
    };

    channelRef = await originalCreateWppChannel({ ...options, onMessage });
    return channelRef;
  };

  SellerHandoff.__testerHandoffBypassInstalled = true;
}

installTesterHandoffBypass();

module.exports = {
  installIsolatedTesterCompatibility,
  installTesterHandoffBypass,
  isResetCommand,
  textFromPayload,
  waitForOperationalConnection,
};
