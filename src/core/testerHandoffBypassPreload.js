'use strict';

const WppClient = require('../services/wppconnectClient');
const SellerHandoff = require('./sellerHandoff');
const { clearHumanBlocks, clearTesterConversationRuntime } = require('./testerRuntime');
const { decision } = require('./decisionLogger');
const { isTesterIdentity, isTestCommandAuthorized } = require('./testCommandAccess');

function textFromPayload(payload = {}) {
  return String(payload.text || payload?.raw?.body || payload?.raw?.caption || payload?.raw?.text || '').trim();
}

function isResetCommand(payload = {}) {
  return textFromPayload(payload).split(/\r?\n/)[0].trim().toLowerCase() === '/resetarsys';
}

function installTesterHandoffBypass() {
  if (SellerHandoff.__testerHandoffBypassInstalled) return;

  const originalGetAutomationBlock = SellerHandoff.getAutomationBlock.bind(SellerHandoff);
  const originalRegisterManualTakeover = SellerHandoff.registerManualTakeover.bind(SellerHandoff);

  SellerHandoff.getAutomationBlock = async function getAutomationBlockWithTesterBypass(channel, clientId) {
    if (isTesterIdentity({ from: clientId })) {
      const cleared = clearHumanBlocks(clientId);
      decision('HANDOFF', 'tester_liberada', { chat: clientId, status: 'livre', motivo: 'tester_identity', bloqueios_limpos: cleared });
      return { blocked: false, reason: null, source: 'tester_identity' };
    }
    return originalGetAutomationBlock(channel, clientId);
  };

  SellerHandoff.registerManualTakeover = function registerManualTakeoverWithTesterBypass(clientId, payload = {}) {
    if (isTesterIdentity({ from: clientId })) {
      const cleared = clearHumanBlocks(clientId);
      decision('HANDOFF', 'mensagem_manual_da_tester_ignorada', { chat: clientId, status: 'livre', motivo: 'tester_identity', bloqueios_limpos: cleared });
      return { bypassed: true, reason: 'tester_identity', cleared };
    }
    return originalRegisterManualTakeover(clientId, payload);
  };

  const originalCreateWppChannel = WppClient.createWppChannel;
  WppClient.createWppChannel = async function createWppChannelWithTesterReset(options = {}) {
    const originalOnMessage = options.onMessage;
    let channelRef = null;

    const onMessage = async (payload = {}) => {
      if (!isResetCommand(payload)) {
        return typeof originalOnMessage === 'function' ? originalOnMessage(payload) : undefined;
      }

      const access = isTestCommandAuthorized({ from: payload.from, raw: payload.raw });
      if (!access.allowed) {
        decision('ADMIN', 'resetarsys_negado', { chat: payload.from || '-', motivo: access.reason }, 'warn');
        return undefined;
      }

      const cleanup = clearTesterConversationRuntime(payload.from);
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

module.exports = { installTesterHandoffBypass, isResetCommand, textFromPayload };
