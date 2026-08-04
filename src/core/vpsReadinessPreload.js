'use strict';

const Store = require('../services/leadStore');
const HumanControl = require('../services/humanControlStore');
const WppClient = require('../services/wppconnectClient');
const { OutboundTracker } = require('./outboundTracker');
const LabelPolicy = require('./labelPolicy');
const { env } = require('../config/env');

function normalizeName(value) {
  return LabelPolicy.normalizeName(value);
}

function extractTimestampMs(message = {}) {
  const candidates = [
    message?.timestamp,
    message?.t,
    message?.messageTimestamp,
    message?.id?.timestamp,
  ];

  for (const candidate of candidates) {
    const value = Number(candidate);
    if (!Number.isFinite(value) || value <= 0) continue;
    return value < 1000000000000 ? value * 1000 : value;
  }

  return null;
}

function isUnreadWithinAge(item = {}, options = {}) {
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const maxAgeHours = Math.max(1, Number(options.maxAgeHours || env.unreadBootstrapMaxAgeHours || 24));
  const timestamp = extractTimestampMs(item.raw || item);
  if (!timestamp) return true;
  const ageMs = Math.max(0, now - timestamp);
  return ageMs <= (maxAgeHours * 60 * 60 * 1000);
}

function findExactSellerLabel(items = []) {
  for (const item of items || []) {
    const classification = LabelPolicy.classifyLabel(item);
    if (classification.category !== LabelPolicy.LABEL_CATEGORY.SELLER) continue;
    return {
      assigned: true,
      seller: classification.seller,
      sellerColor: env.sellerLabelRules?.[classification.seller] || null,
      labelName: classification.name,
      labelId: String(item?.id || ''),
      labelHex: String(item?.hexColor || '').trim().toLowerCase() || null,
      labelColorIndex: Number.isFinite(Number(item?.colorIndex)) ? Number(item.colorIndex) : null,
      matchMode: 'exact_name',
    };
  }
  return null;
}

function installHumanBlockWriteDeduplication() {
  if (HumanControl.__vpsWriteDeduplicationInstalled) return;

  const originalSetBlock = HumanControl.setBlock.bind(HumanControl);
  HumanControl.setBlock = function setBlockWithoutDuplicateWrites(clientId, payload = {}) {
    const current = HumanControl.getBlock(clientId);
    const existing = current?.control;
    const reason = String(payload.reason || 'human_block');
    const source = String(payload.source || 'manual');
    const seller = String(payload.seller || '');
    const labelName = String(payload.labelName || '');
    const permanentReason = [
      'manual_outbound_message',
      'manual_outbound_history',
      'manual_label',
      'seller_label',
    ].includes(reason);

    if (current?.blocked
      && permanentReason
      && !existing?.blockedUntil
      && String(existing?.reason || '') === reason
      && String(existing?.source || '') === source
      && String(existing?.seller || '') === seller
      && String(existing?.labelName || '') === labelName) {
      return existing;
    }

    return originalSetBlock(clientId, payload);
  };

  HumanControl.__vpsWriteDeduplicationInstalled = true;
}

function installUnreadAgeGuard() {
  if (WppClient.__vpsUnreadAgeGuardInstalled) return;

  const originalCollectUnreadMessages = WppClient.collectUnreadMessages.bind(WppClient);
  WppClient.collectUnreadMessages = async function collectRecentUnreadMessages(client) {
    const items = await originalCollectUnreadMessages(client);
    const recent = [];
    let stale = 0;

    for (const item of items || []) {
      if (isUnreadWithinAge(item)) recent.push(item);
      else stale += 1;
    }

    if (stale) {
      console.log(
        `[RECUPERAÇÃO] ${stale} mensagem(ns) não lida(s) antiga(s) ignorada(s) `
        + `| limite=${env.unreadBootstrapMaxAgeHours}h`,
      );
    }

    return recent;
  };

  WppClient.__vpsUnreadAgeGuardInstalled = true;
}

function installOutboundCacheLimit() {
  if (OutboundTracker.prototype.__vpsCacheLimitInstalled) return;

  const originalRegister = OutboundTracker.prototype.register;
  OutboundTracker.prototype.register = function registerWithBoundedCache(...args) {
    const item = originalRegister.apply(this, args);
    this.purge();

    const maxEntries = Math.max(500, Number(env.runtimeCacheMaxEntries || 5000));
    while (this.byChat?.size > maxEntries) {
      const oldestChatId = this.byChat.keys().next().value;
      if (!oldestChatId) break;
      this.byChat.delete(oldestChatId);
    }

    return item;
  };

  OutboundTracker.prototype.__vpsCacheLimitInstalled = true;
}

function startPeriodicMaintenance() {
  if (global.__personalizeVpsMaintenanceTimer) return;

  const intervalMs = Math.max(60000, Number(env.maintenanceIntervalMs || 900000));
  const run = () => {
    try { Store.purgeExpiredSessions(); } catch (error) {
      console.warn('[MANUTENÇÃO] falha ao limpar sessões:', error?.message || error);
    }
    try { HumanControl.purgeExpiredBlocks(); } catch (error) {
      console.warn('[MANUTENÇÃO] falha ao limpar bloqueios:', error?.message || error);
    }
  };

  const timer = setInterval(run, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  global.__personalizeVpsMaintenanceTimer = timer;
}

installHumanBlockWriteDeduplication();
installUnreadAgeGuard();
installOutboundCacheLimit();
startPeriodicMaintenance();

console.log(
  `[VPS-READY] vendedores=${Object.keys(env.sellerLabelRules).join(', ')} `
  + `| nãoLidasAté=${env.unreadBootstrapMaxAgeHours}h `
  + `| manutenção=${env.maintenanceIntervalMs}ms `
  + `| cacheMáximo=${env.runtimeCacheMaxEntries}`,
);

module.exports = {
  extractTimestampMs,
  findExactSellerLabel,
  isUnreadWithinAge,
  normalizeName,
};
