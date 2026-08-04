'use strict';

const WppClient = require('../services/wppconnectClient');
const { BufferManager } = require('./bufferManager');
const { createSellerLabelUpdateHandler } = require('./sellerLabelEvents');

function installSellerLabelEvents() {
  if (WppClient.__sellerLabelEventsInstalled) return WppClient;
  const originalCreateWppChannel = WppClient.createWppChannel;

  WppClient.createWppChannel = async function createChannelWithSellerLabelEvents(options = {}) {
    const channel = await originalCreateWppChannel(options);
    const client = channel?.client;
    if (typeof client?.onUpdateLabel !== 'function') {
      console.warn('[ETIQUETAS][EVENTO] onUpdateLabel indisponível nesta versão do WPPConnect.');
      return channel;
    }

    const handler = createSellerLabelUpdateHandler({
      getChannel: () => channel,
      clearBuffer: (clientId) => BufferManager.clearAllFor(clientId),
      delayMs: 500,
    });
    client.onUpdateLabel(async (data) => {
      try {
        await handler({ data, channel });
      } catch (error) {
        console.warn('[ETIQUETAS][EVENTO] falha ao processar atualização:', error?.message || error);
      }
    });
    console.log('[ETIQUETAS][EVENTO] monitor registrado com bloqueio persistente e limpeza do buffer real');
    return channel;
  };

  WppClient.__sellerLabelEventsInstalled = true;
  return WppClient;
}

installSellerLabelEvents();

module.exports = { installSellerLabelEvents };
