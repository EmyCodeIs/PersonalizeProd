'use strict';

const WppClient = require('../services/wppconnectClient');
const Inbox = require('../services/messageInboxStore');
const { connectionConfig } = require('../config/connectionConfig');
const { getActiveConnectionSupervisor } = require('../services/connectionSupervisor');

function inboxId(payload = {}) {
  return String(
    payload.__personalizeInboxId
    || payload?.raw?.__personalizeInboxId
    || ''
  ).trim() || null;
}

function deferInboxMessage(payload = {}, supervisor) {
  const id = inboxId(payload);
  if (!id) return false;

  const availableAt = new Date(Date.now() + connectionConfig.deferRetryMs).toISOString();
  Inbox.transition([id], Inbox.STATUS.FAILED_RETRYABLE, {
    reason: 'connection_not_ready',
    patch: {
      availableAt,
      leaseOwner: null,
      leaseUntil: null,
      lastError: {
        code: 'CONNECTION_NOT_READY',
        message: `Mensagem aguardando conexão READY; estado atual=${supervisor?.state || 'UNKNOWN'}.`,
        at: new Date().toISOString(),
      },
    },
  });
  return true;
}

function patchRecoverableLookup() {
  if (Inbox.__connectionReadinessLookupPatched) return;
  const originalListRecoverable = Inbox.listRecoverable.bind(Inbox);

  Inbox.listRecoverable = function listRecoverableOnlyWhenReady(options = {}) {
    const supervisor = getActiveConnectionSupervisor();
    if (supervisor && !supervisor.isReady()) return [];
    return originalListRecoverable(options);
  };

  Inbox.__connectionReadinessLookupPatched = true;
}

function installConnectionReadinessGate() {
  patchRecoverableLookup();
  if (WppClient.__connectionReadinessGateInstalled) return WppClient;

  const originalCreateWppChannel = WppClient.createWppChannel.bind(WppClient);
  WppClient.createWppChannel = async function createWppChannelWithReadinessGate(options = {}) {
    const originalOnMessage = options.onMessage;

    const channel = await originalCreateWppChannel({
      ...options,
      onMessage: async (payload = {}) => {
        const supervisor = getActiveConnectionSupervisor();
        if (supervisor && !supervisor.isReady()) {
          const deferred = deferInboxMessage(payload, supervisor);
          console.log(
            `[CONEXÃO] mensagem adiada até READY | estado=${supervisor.state} `
            + `| geração=${supervisor.generation} | inbox=${inboxId(payload) || '-'} `
            + `| persistida=${deferred ? 'sim' : 'não'}`,
          );
          return { deferred: true, reason: 'CONNECTION_NOT_READY' };
        }
        return typeof originalOnMessage === 'function' ? originalOnMessage(payload) : undefined;
      },
    });

    const supervisor = channel?.connectionSupervisor || getActiveConnectionSupervisor();
    if (supervisor && !channel.__connectionReadyRecoveryBridgeInstalled) {
      supervisor.on('ready', ({ generation }) => {
        if (generation !== channel.connectionGeneration) return;
        setTimeout(() => {
          channel.__runPersistentInboxRecovery?.(`connection-ready-g${generation}`).catch((error) => {
            console.warn('[CONEXÃO] falha ao liberar Inbox depois de READY:', error?.message || error);
          });
        }, 0).unref?.();
      });
      channel.__connectionReadyRecoveryBridgeInstalled = true;
    }

    return channel;
  };

  WppClient.__connectionReadinessGateInstalled = true;
  return WppClient;
}

installConnectionReadinessGate();

module.exports = {
  deferInboxMessage,
  inboxId,
  installConnectionReadinessGate,
  patchRecoverableLookup,
};
