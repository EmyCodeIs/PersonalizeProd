'use strict';

const WppClient = require('../services/wppconnectClient');
const { BufferManager } = require('./bufferManager');
const {
  RESET_MODE,
  formatResetConfirmation,
  resetConversation,
} = require('./resetService');

function firstLine(value) {
  return String(value || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) || '';
}

function payloadText(payload = {}) {
  return String(
    payload.text
    || payload?.raw?.body
    || payload?.raw?.caption
    || payload?.raw?.text
    || ''
  ).trim();
}

function payloadMessageId(payload = {}) {
  return String(
    payload?.raw?.id?._serialized
    || payload?.raw?.id
    || payload?.raw?.messageId
    || payload?.raw?.key?.id
    || ''
  ).trim() || null;
}

function isFullResetCommand(value) {
  return firstLine(value).toLowerCase() === '/resetarsys';
}

function installResetService() {
  if (WppClient.__unifiedResetServiceInstalled) return WppClient;
  const originalCreateWppChannel = WppClient.createWppChannel;

  WppClient.createWppChannel = async function createWppChannelWithUnifiedReset(options = {}) {
    const originalOnMessage = options.onMessage;
    let channelRef = null;

    const onMessage = async (payload = {}) => {
      const text = payloadText(payload);
      if (!isFullResetCommand(text)) {
        return typeof originalOnMessage === 'function' ? originalOnMessage(payload) : undefined;
      }

      const clientId = String(
        payload.from
        || payload?.raw?.from
        || payload?.raw?.chatId
        || payload?.raw?.id?.remote
        || ''
      ).trim();

      const result = await resetConversation({
        clientId,
        channel: channelRef,
        mode: RESET_MODE.TESTER_FULL,
        command: '/resetarsys',
        actor: payload.source || 'test_admin',
        messageId: payloadMessageId(payload),
        clearBuffer: (chatId) => BufferManager.clearAllFor(chatId),
      });

      await channelRef?.sendText?.(
        clientId,
        formatResetConfirmation(result),
        { noDelay: true, noTyping: true },
      );

      console.log(`[RESETARSYS] comando concluído sem encaminhar ao fluxo legado | cliente=${clientId}`);
      return result;
    };

    channelRef = await originalCreateWppChannel({ ...options, onMessage });
    return channelRef;
  };

  WppClient.__unifiedResetServiceInstalled = true;
  return WppClient;
}

installResetService();

module.exports = {
  firstLine,
  installResetService,
  isFullResetCommand,
  payloadMessageId,
  payloadText,
};
