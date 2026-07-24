'use strict';

const WppClient = require('../services/wppconnectClient');
const { env } = require('../config/env');
const { isInternalTestCommand, firstLine } = require('./resetCommandHandoffPreload');
const { isTestCommandAuthorized } = require('./testCommandAccess');
const { isSystemResetCommand } = require('./systemReset');

function extractText(payload = {}) {
  return String(
    payload.text
    || payload?.raw?.body
    || payload?.raw?.caption
    || payload?.raw?.text
    || ''
  ).trim();
}

function installTestCommandAccessGuard() {
  if (WppClient.__testCommandAccessGuardInstalled) return;

  const originalCreateWppChannel = WppClient.createWppChannel;
  WppClient.createWppChannel = async function createWppChannelWithTestCommandGuard(options = {}) {
    const originalOnMessage = options.onMessage;

    const onMessage = async (payload = {}) => {
      const text = extractText(payload);
      if (!isInternalTestCommand(text)) {
        return typeof originalOnMessage === 'function' ? originalOnMessage(payload) : undefined;
      }

      const command = firstLine(text).toLowerCase();
      if (!env.enableTestCommands && !isSystemResetCommand(command)) {
        console.warn(`[COMANDO TESTE] ignorado porque ENABLE_TEST_COMMANDS=false | comando=${command}`);
        return undefined;
      }

      const access = isTestCommandAuthorized({ from: payload.from, raw: payload.raw });
      if (!access.allowed) {
        console.warn(
          `[COMANDO TESTE] acesso negado | comando=${command} | chat=${String(payload.from || '-')} `
          + `| motivo=${access.reason}`,
        );
        return undefined;
      }

      console.log(
        `[COMANDO TESTE] administrador autorizado | comando=${command} `
        + `| chat=${String(payload.from || '-')} | via=${access.reason}`,
      );

      return typeof originalOnMessage === 'function' ? originalOnMessage(payload) : undefined;
    };

    return originalCreateWppChannel({
      ...options,
      onMessage,
    });
  };

  WppClient.__testCommandAccessGuardInstalled = true;
}

installTestCommandAccessGuard();

module.exports = {
  extractText,
  installTestCommandAccessGuard,
};
