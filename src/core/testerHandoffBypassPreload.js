'use strict';

const WppClient = require('../services/wppconnectClient');
const TesterRuntime = require('./testerRuntime');
const Synchronization = require('./synchronizationGuardPreload');
const SafeResetCleanup = require('./safeResetCleanupOverridePreload');
const ResetStore = require('../services/handoffResetStore');
const { decision } = require('./decisionLogger');
const Access = require('./testCommandAccess');

const RESET_CONFIRMATION = 'Sistema resetado para teste.\n\nConversa zerada para teste. Envie uma nova mensagem para começar como primeiro contato.';

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

async function sendResetConfirmation(channel, clientId, text = RESET_CONFIRMATION) {
  // A confirmação do comando precisa sair mesmo quando uma etiqueta externa ainda
  // está anexada ao contato. Antes do envio direto, executamos explicitamente a
  // limpeza segura que remove nota e etiquetas gerenciadas, preservando etiquetas
  // manuais não gerenciadas. Os demais envios continuam sujeitos ao handoff.
  const rawSendText = channel?.client?.sendText;
  if (typeof rawSendText === 'function') {
    const safeCleanup = await SafeResetCleanup.safeCleanup(channel, clientId);
    const pending = channel?.outboundTracker?.register?.(clientId, {
      type: 'text',
      text,
    }) || null;
    try {
      const result = await rawSendText.call(channel.client, clientId, text);
      channel?.outboundTracker?.confirm?.(pending, result);
      decision('ADMIN', 'resetarsys_confirmação_enviada', {
        chat: clientId,
        resultado: 'ok',
        transporte: 'cliente_wpp_autorizado',
        etiquetas_gerenciadas_removidas: safeCleanup?.labels?.removed ?? 'não_confirmado',
        etiquetas_manuais_preservadas: safeCleanup?.labels?.preserved ?? 'não_confirmado',
      });
      return result;
    } catch (error) {
      channel?.outboundTracker?.fail?.(pending);
      throw error;
    }
  }

  // Em ambientes antigos sem client.sendText, mantém o caminho já existente;
  // o wrapper de safeResetCleanup reconhecerá o prefixo e fará a mesma limpeza.
  return channel?.sendText?.(clientId, text, { noDelay: true, noTyping: true });
}

function installTesterHandoffBypass() {
  if (WppClient.__testerHandoffBypassInstalled) return;

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
      const checkpoint = cleanup?.handoffResetCheckpoint
        || ResetStore.markReset(payload.from, { reason: 'resetarsys' });

      decision('ADMIN', 'resetarsys_limpeza_local', {
        chat: payload.from,
        resultado: 'ok',
        buffers: cleanup.discardedBuffers,
        tarefas: cleanup.cancelledTasks,
        bloqueios: cleanup.blocksCleared,
        atividade_bot: cleanup.activityCleared,
        sessão_removida: Boolean(cleanup.reset?.sessionRemoved),
        perfil_removido: Boolean(cleanup.reset?.profileRemoved),
        corte_historico: checkpoint?.at || '-',
      });

      await sendResetConfirmation(channelRef, payload.from);
      return undefined;
    };

    channelRef = await originalCreateWppChannel({ ...options, onMessage });
    return channelRef;
  };

  WppClient.__testerHandoffBypassInstalled = true;
}

installTesterHandoffBypass();

module.exports = {
  RESET_CONFIRMATION,
  installTesterHandoffBypass,
  isResetCommand,
  sendResetConfirmation,
  textFromPayload,
  waitForOperationalConnection,
};
