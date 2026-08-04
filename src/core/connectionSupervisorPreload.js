'use strict';

const { connectionConfig } = require('../config/connectionConfig');
const {
  ConnectionSupervisor,
  DISCONNECTED_RAW_STATES,
  READY_RAW_STATES,
  STATES,
  getActiveConnectionSupervisor,
  isClientReady,
  normalizeRawState,
  setActiveConnectionSupervisor,
} = require('../services/connectionSupervisor');

let pendingSupervisor = null;

function patchQrAccess() {
  const QrAccess = require('../services/qrAccess');
  if (QrAccess.__connectionSupervisorPatched) return QrAccess;

  const originalPublishConnected = QrAccess.publishConnected.bind(QrAccess);
  const originalPublishMessage = QrAccess.publishMessage.bind(QrAccess);
  const originalPublishState = QrAccess.publishState.bind(QrAccess);

  QrAccess.publishConnected = function publishOnlyRealConnected(connectionState = 'CONNECTED') {
    const normalized = normalizeRawState(connectionState);
    if (READY_RAW_STATES.has(normalized)) return originalPublishConnected(normalized);

    const message = ['SYNCING', 'RESUMING'].includes(normalized)
      ? 'WhatsApp sincronizando. O atendimento ainda não foi liberado.'
      : 'WhatsApp conectado parcialmente, aguardando confirmação READY.';
    return originalPublishMessage(message, normalized);
  };

  QrAccess.publishState = function publishStateWithReadiness(connectionState, message = '') {
    const normalized = normalizeRawState(connectionState);
    if (READY_RAW_STATES.has(normalized)) return originalPublishConnected(normalized);
    if (DISCONNECTED_RAW_STATES.has(normalized)) return originalPublishState(normalized, message);

    const waitingMessage = message || (
      ['SYNCING', 'RESUMING'].includes(normalized)
        ? 'WhatsApp sincronizando. O atendimento permanece pausado.'
        : 'WhatsApp aguardando conexão operacional.'
    );
    return originalPublishMessage(waitingMessage, normalized);
  };

  QrAccess.__connectionSupervisorPatched = true;
  return QrAccess;
}

function replaceExportedCreate(wppconnect, patchedCreate) {
  try {
    wppconnect.create = patchedCreate;
    if (wppconnect.create === patchedCreate) return true;
  } catch (_) {}

  try {
    Object.defineProperty(wppconnect, 'create', {
      configurable: true,
      enumerable: true,
      writable: true,
      value: patchedCreate,
    });
    return wppconnect.create === patchedCreate;
  } catch (_) {
    return false;
  }
}

function patchWppConnectCreate() {
  const wppconnect = require('@wppconnect-team/wppconnect');
  if (wppconnect.__personalizeConnectionCreatePatched) return wppconnect;

  const originalCreate = wppconnect.create.bind(wppconnect);
  const patchedCreate = async function createWithFiniteSyncTimeout(options = {}) {
    const supervisor = pendingSupervisor || getActiveConnectionSupervisor();
    const generation = supervisor?.generation;
    const originalCatchQr = options.catchQR;
    const originalStatusFind = options.statusFind;

    const resolvedOptions = {
      ...options,
      deviceSyncTimeout: connectionConfig.deviceSyncTimeoutMs,
      catchQR: (...args) => {
        supervisor?.observeState('PAIRING', { source: 'catchQR', generation });
        return typeof originalCatchQr === 'function' ? originalCatchQr(...args) : undefined;
      },
      statusFind: (statusSession, ...args) => {
        supervisor?.observeState(statusSession, { source: 'statusFind', generation });
        return typeof originalStatusFind === 'function'
          ? originalStatusFind(statusSession, ...args)
          : undefined;
      },
    };

    console.log(
      `[CONEXÃO] WPPConnect create | deviceSyncTimeout=${resolvedOptions.deviceSyncTimeout}ms `
      + `| autoClose=${resolvedOptions.autoClose}`,
    );

    try {
      const client = await originalCreate(resolvedOptions);
      supervisor?.attachClient(client, generation);
      return client;
    } catch (error) {
      supervisor?.reportFatal(error, 'wppconnect_create_failed');
      throw error;
    }
  };

  if (!replaceExportedCreate(wppconnect, patchedCreate)) {
    throw new Error('Não foi possível instalar o timeout finito no wppconnect.create.');
  }

  Object.defineProperty(wppconnect, '__personalizeConnectionCreatePatched', {
    configurable: true,
    value: true,
  });
  return wppconnect;
}

function wrapOutboundActivity(channel, supervisor) {
  if (!channel || channel.__connectionOutboundActivityWrapped) return;
  for (const method of ['sendText', 'sendImage', 'sendDocument']) {
    if (typeof channel[method] !== 'function') continue;
    const original = channel[method].bind(channel);
    channel[method] = async (...args) => {
      const result = await original(...args);
      supervisor.markOutbound();
      return result;
    };
  }
  channel.__connectionOutboundActivityWrapped = true;
}

function installConnectionSupervisor() {
  patchQrAccess();
  patchWppConnectCreate();

  const WppClient = require('../services/wppconnectClient');
  if (WppClient.__connectionSupervisorInstalled) return WppClient;

  const originalCreateWppChannel = WppClient.createWppChannel.bind(WppClient);
  const originalCollectUnreadMessages = WppClient.collectUnreadMessages.bind(WppClient);

  WppClient.collectUnreadMessages = async function collectUnreadOnlyWhenReady(client) {
    if (!isClientReady(client)) {
      console.log('[CONEXÃO] busca de não lidas adiada: sessão ainda não está READY.');
      return [];
    }
    return originalCollectUnreadMessages(client);
  };

  WppClient.createWppChannel = async function createWppChannelWithSupervisor(options = {}) {
    if (!connectionConfig.enabled) return originalCreateWppChannel(options);

    const supervisor = new ConnectionSupervisor({ config: connectionConfig });
    const generation = supervisor.beginGeneration('wpp_channel_create');
    setActiveConnectionSupervisor(supervisor);
    pendingSupervisor = supervisor;

    const originalOnMessage = options.onMessage;
    const originalOnOutgoingMessage = options.onOutgoingMessage;

    try {
      const channel = await originalCreateWppChannel({
        ...options,
        onMessage: async (payload = {}) => {
          supervisor.markInbound();
          return typeof originalOnMessage === 'function' ? originalOnMessage(payload) : undefined;
        },
        onOutgoingMessage: async (payload = {}) => {
          supervisor.markOutbound();
          return typeof originalOnOutgoingMessage === 'function'
            ? originalOnOutgoingMessage(payload)
            : undefined;
        },
      });

      supervisor.attachClient(channel?.client, generation);
      channel.connectionSupervisor = supervisor;
      channel.connectionGeneration = generation;
      channel.isConnectionReady = () => supervisor.isReady();
      channel.whenConnectionReady = (options = {}) => supervisor.waitUntilReady(options);
      channel.connectionHealth = () => supervisor.snapshot();
      wrapOutboundActivity(channel, supervisor);

      if (connectionConfig.waitForReadyBeforeChannelReturn && !supervisor.isReady()) {
        console.log(
          `[CONEXÃO] canal criado; aguardando READY antes de liberar bootstrap `
          + `| geração=${generation}`,
        );
        await supervisor.waitUntilReady({ timeoutMs: connectionConfig.readyWaitTimeoutMs });
      }

      console.log(`[CONEXÃO] canal liberado em READY | geração=${generation}`);
      return channel;
    } catch (error) {
      supervisor.reportFatal(error, 'channel_create_failed');
      throw error;
    } finally {
      if (pendingSupervisor === supervisor) pendingSupervisor = null;
    }
  };

  WppClient.__connectionSupervisorInstalled = true;
  return WppClient;
}

installConnectionSupervisor();

module.exports = {
  STATES,
  connectionConfig,
  installConnectionSupervisor,
  patchQrAccess,
  patchWppConnectCreate,
  wrapOutboundActivity,
};
