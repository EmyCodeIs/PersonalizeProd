'use strict';

const crypto = require('crypto');
const WppClient = require('../services/wppconnectClient');
const Inbox = require('../services/messageInboxStore');
const HumanControl = require('../services/humanControlStore');
const Store = require('../services/leadStore');
const CustomerFlow = require('../flow/customerFlow');
const { BufferManager } = require('./bufferManager');
const { inboxConfig } = require('../config/inboxConfig');

const runtimeOwner = `runtime:${process.pid}:${crypto.randomBytes(6).toString('hex')}`;

function inboxIdFromRaw(raw = {}) {
  return String(raw?.__personalizeInboxId || '').trim() || null;
}

function inboxIdsFromMessages(messages = []) {
  return [...new Set((messages || [])
    .map((message) => inboxIdFromRaw(message?.raw || message))
    .filter(Boolean))];
}

function attachInboxMetadata(payload = {}, inboxId, originalMessageId = null) {
  const raw = payload?.raw && typeof payload.raw === 'object' ? payload.raw : {};
  return {
    ...payload,
    __personalizeInboxId: inboxId,
    raw: {
      ...raw,
      __personalizeInboxId: inboxId,
      __personalizeOriginalMessageId:
        originalMessageId
        || raw?.__personalizeOriginalMessageId
        || Inbox.originalMessageId(raw),
    },
  };
}

function failureOptions() {
  return {
    maxAttempts: inboxConfig.maxAttempts,
    baseDelayMs: inboxConfig.retryBaseMs,
    maxDelayMs: inboxConfig.retryMaxMs,
  };
}

function markUnstarted(ids, clientId, reason = 'processing_not_started') {
  if (!ids.length) return;
  const block = HumanControl.getBlock(clientId);
  if (block?.blocked) {
    Inbox.markIgnored(ids, Inbox.STATUS.IGNORED_HANDOFF, {
      reason: block.control?.reason || 'human_block',
    });
    return;
  }

  Inbox.markFailure(ids, Object.assign(new Error(reason), { code: 'PROCESSING_NOT_STARTED' }), failureOptions());
}

function installBufferTracking() {
  if (BufferManager.prototype.__persistentInboxTrackingInstalled) return;

  const originalPush = BufferManager.prototype.push;
  const originalClear = BufferManager.prototype.clear;

  BufferManager.prototype.push = function pushWithPersistentInbox(clientId, message, options = {}) {
    if (!this.__persistentInboxFlushWrapped) {
      const originalOnFlush = this.onFlush;
      this.onFlush = async (flushClientId, messages) => {
        const ids = inboxIdsFromMessages(messages);
        if (ids.length) {
          Inbox.markQueued(ids, {
            conversationId: flushClientId,
            reason: 'buffer_flushed',
          });
        }

        try {
          const result = await originalOnFlush(flushClientId, messages);
          const stillQueued = ids.filter((id) => Inbox.readRecord(id)?.status === Inbox.STATUS.QUEUED);
          markUnstarted(stillQueued, flushClientId);
          return result;
        } catch (error) {
          const pending = ids.filter((id) => {
            const status = Inbox.readRecord(id)?.status;
            return status && !Inbox.TERMINAL.has(status) && status !== Inbox.STATUS.FAILED_RETRYABLE;
          });
          if (pending.length) Inbox.markFailure(pending, error, failureOptions());
          throw error;
        }
      };
      this.__persistentInboxFlushWrapped = true;
    }

    const inboxId = inboxIdFromRaw(message?.raw || message);
    if (inboxId) {
      Inbox.markBuffered([inboxId], {
        conversationId: clientId,
        reason: 'buffer_push',
      });
    }

    return originalPush.call(this, clientId, message, options);
  };

  BufferManager.prototype.clear = function clearWithPersistentInbox(clientId) {
    const item = this.map?.get?.(String(clientId || '').trim());
    const ids = inboxIdsFromMessages(item?.messages || []);
    const result = originalClear.call(this, clientId);

    if (ids.length) {
      const block = HumanControl.getBlock(clientId);
      if (block?.blocked) {
        Inbox.markIgnored(ids, Inbox.STATUS.IGNORED_HANDOFF, {
          reason: block.control?.reason || 'human_block',
        });
      }
    }

    return result;
  };

  BufferManager.prototype.__persistentInboxTrackingInstalled = true;
}

function installFlowTracking() {
  if (CustomerFlow.__persistentInboxTrackingInstalled) return;
  const originalProcessCustomerMessage = CustomerFlow.processCustomerMessage;

  CustomerFlow.processCustomerMessage = async function processCustomerMessageWithInbox(args = {}) {
    const ids = inboxIdsFromMessages(args.messages || []);
    if (!ids.length || !inboxConfig.enabled) return originalProcessCustomerMessage(args);

    const claimed = Inbox.claimBatch(ids, {
      owner: runtimeOwner,
      leaseMs: inboxConfig.leaseMs,
      reason: 'customer_flow',
    });
    const claimedIds = claimed.map((record) => record.id);

    if (claimedIds.length !== ids.length) {
      if (claimedIds.length) {
        Inbox.markFailure(
          claimedIds,
          Object.assign(new Error('Nem todas as mensagens do grupo puderam adquirir lease.'), {
            code: 'INBOX_BATCH_LEASE_CONFLICT',
          }),
          failureOptions(),
        );
      }
      console.warn(
        `[INBOX] grupo não processado por conflito de lease | cliente=${args.clientId} `
        + `| esperado=${ids.length} | obtido=${claimedIds.length}`,
      );
      return Store.getSession(args.clientId);
    }

    const heartbeatMs = Math.max(5000, Math.floor(inboxConfig.leaseMs / 3));
    const heartbeat = setInterval(() => {
      try {
        Inbox.renewLease(claimedIds, {
          owner: runtimeOwner,
          leaseMs: inboxConfig.leaseMs,
        });
      } catch (error) {
        console.warn('[INBOX] falha ao renovar lease:', error?.message || error);
      }
    }, heartbeatMs);
    if (typeof heartbeat.unref === 'function') heartbeat.unref();

    try {
      const result = await originalProcessCustomerMessage(args);
      Inbox.markProcessed(claimedIds, { reason: 'customer_flow_completed' });
      return result;
    } catch (error) {
      Inbox.markFailure(claimedIds, error, failureOptions());
      throw error;
    } finally {
      clearInterval(heartbeat);
    }
  };

  CustomerFlow.__persistentInboxTrackingInstalled = true;
}

function installChannelTracking() {
  if (WppClient.__persistentInboxInstalled) return;
  const originalCreateWppChannel = WppClient.createWppChannel;

  WppClient.createWppChannel = async function createWppChannelWithPersistentInbox(options = {}) {
    const originalOnMessage = options.onMessage;
    let channelRef = null;
    let recoveryRunning = false;

    const onMessage = async (payload = {}) => {
      if (!inboxConfig.enabled || typeof originalOnMessage !== 'function') {
        return typeof originalOnMessage === 'function' ? originalOnMessage(payload) : undefined;
      }

      const replay = payload.__personalizeInboxReplay === true
        || payload?.raw?.__personalizeInboxReplay === true;
      let record;

      if (replay) {
        const id = String(payload.__personalizeInboxId || payload?.raw?.__personalizeInboxId || '').trim();
        record = Inbox.readRecord(id);
        if (!record || Inbox.TERMINAL.has(record.status)) return undefined;
      } else {
        const received = Inbox.receive({
          from: payload.from,
          conversationId: payload.from,
          text: payload.text,
          raw: payload.raw,
          source: payload.source,
        });
        record = received.record;
        if (received.duplicate) {
          console.log(
            `[INBOX] duplicata ignorada | id=${record.id} | status=${record.status} `
            + `| cliente=${record.conversationId || payload.from || '-'}`,
          );
          return undefined;
        }
      }

      const enriched = attachInboxMetadata(payload, record.id, record.messageId);

      try {
        const result = await originalOnMessage(enriched);
        const current = Inbox.readRecord(record.id);
        if (current?.status === Inbox.STATUS.RECEIVED) {
          Inbox.markIgnored([record.id], Inbox.STATUS.IGNORED_POLICY, {
            reason: 'handler_returned_without_buffer',
          });
        }
        return result;
      } catch (error) {
        Inbox.markFailure([record.id], error, failureOptions());
        throw error;
      }
    };

    const runRecovery = async (reason = 'scheduled') => {
      if (!inboxConfig.enabled || recoveryRunning) return { skipped: true };
      recoveryRunning = true;
      let replayed = 0;
      let ignored = 0;

      try {
        const records = Inbox.listRecoverable({
          staleMs: inboxConfig.staleMs,
          limit: inboxConfig.recoveryBatchSize,
        });

        for (const current of records) {
          const block = HumanControl.getBlock(current.conversationId || current.from);
          if (block?.blocked) {
            Inbox.markIgnored([current.id], Inbox.STATUS.IGNORED_HANDOFF, {
              reason: block.control?.reason || 'human_block',
            });
            ignored += 1;
            continue;
          }

          const record = Inbox.requeueForReplay(current.id, { reason });
          const replayPayload = Inbox.toReplayPayload(record, {
            source: `persistent-inbox-${reason}`,
          });
          if (!replayPayload) continue;
          replayed += 1;
          await onMessage(replayPayload);
        }

        if (records.length || reason === 'startup') {
          console.log(
            `[INBOX] recuperação ${reason} concluída | encontrados=${records.length} `
            + `| reenviados=${replayed} | handoff=${ignored}`,
          );
        }
        return { found: records.length, replayed, ignored };
      } finally {
        recoveryRunning = false;
      }
    };

    channelRef = await originalCreateWppChannel({ ...options, onMessage });
    if (!channelRef) return channelRef;

    channelRef.__runPersistentInboxRecovery = runRecovery;
    channelRef.__messageInboxStats = () => Inbox.stats();

    const startupTimer = setTimeout(() => {
      runRecovery('startup').catch((error) => {
        console.warn('[INBOX] falha na recuperação inicial:', error?.message || error);
      });
    }, inboxConfig.recoveryDelayMs);
    if (typeof startupTimer.unref === 'function') startupTimer.unref();

    const retryTimer = setInterval(() => {
      runRecovery('retry').catch((error) => {
        console.warn('[INBOX] falha na rodada de retry:', error?.message || error);
      });
    }, inboxConfig.retryPollMs);
    if (typeof retryTimer.unref === 'function') retryTimer.unref();

    if (!global.__personalizeInboxMaintenanceTimer) {
      const maintenanceTimer = setInterval(() => {
        try {
          const result = Inbox.purge({
            processedTtlDays: inboxConfig.processedTtlDays,
            failedTtlDays: inboxConfig.failedTtlDays,
            maxEntries: inboxConfig.maxEntries,
          });
          if (result.removed) console.log(`[INBOX] manutenção removeu ${result.removed} registro(s) antigo(s).`);
        } catch (error) {
          console.warn('[INBOX] falha na manutenção:', error?.message || error);
        }
      }, inboxConfig.maintenanceMs);
      if (typeof maintenanceTimer.unref === 'function') maintenanceTimer.unref();
      global.__personalizeInboxMaintenanceTimer = maintenanceTimer;
    }

    console.log(
      `[INBOX] persistente ativa | lease=${inboxConfig.leaseMs}ms `
      + `| tentativas=${inboxConfig.maxAttempts} | lote=${inboxConfig.recoveryBatchSize}`,
    );
    return channelRef;
  };

  WppClient.__persistentInboxInstalled = true;
}

if (inboxConfig.enabled) {
  installBufferTracking();
  installFlowTracking();
  installChannelTracking();
}

module.exports = {
  attachInboxMetadata,
  inboxIdFromRaw,
  inboxIdsFromMessages,
  installBufferTracking,
  installChannelTracking,
  installFlowTracking,
  markUnstarted,
  runtimeOwner,
};
