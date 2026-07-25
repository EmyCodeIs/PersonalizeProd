'use strict';

const WppClient = require('../services/wppconnectClient');
const { env } = require('../config/env');

const INTERNAL_TEST_COMMANDS = new Set(['/reset', '/reiniciar', '/resetarsys']);

function firstLine(value) {
  return String(value || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) || '';
}

function isInternalTestCommand(value) {
  return INTERNAL_TEST_COMMANDS.has(firstLine(value).toLowerCase());
}

function installResetCommandHandoffBypass() {
  if (WppClient.__resetCommandHandoffBypassInstalled) return;

  const originalCreateWppChannel = WppClient.createWppChannel;
  WppClient.createWppChannel = async function createWppChannelWithResetCommandBypass(options = {}) {
    const originalOnMessage = options.onMessage;
    const originalOnOutgoingMessage = options.onOutgoingMessage;

    const onOutgoingMessage = async (payload = {}) => {
      const text = String(payload.text || payload?.raw?.body || payload?.raw?.text || '').trim();

      // Quando o comando é digitado pelo próprio WhatsApp Business, WPPConnect o
      // entrega como mensagem de saída. Ele precisa voltar ao processador de
      // comandos antes que o monitor de saída o classifique como atendimento humano.
      const command = firstLine(text).toLowerCase();
      const shouldRouteCommand = isInternalTestCommand(text)
        && (env.enableTestCommands || command === '/resetarsys');
      if (shouldRouteCommand) {
        if (typeof originalOnMessage !== 'function') return undefined;
        console.log(`[COMANDO TESTE] saída manual encaminhada ao processador sem handoff | comando=${command}`);
        return originalOnMessage({
          ...payload,
          text,
          source: 'manual-test-command',
        });
      }

      if (typeof originalOnOutgoingMessage === 'function') {
        return originalOnOutgoingMessage(payload);
      }
      return undefined;
    };

    return originalCreateWppChannel({
      ...options,
      onOutgoingMessage,
    });
  };

  WppClient.__resetCommandHandoffBypassInstalled = true;
}

installResetCommandHandoffBypass();

module.exports = {
  INTERNAL_TEST_COMMANDS,
  firstLine,
  installResetCommandHandoffBypass,
  isInternalTestCommand,
};
