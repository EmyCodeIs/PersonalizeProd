'use strict';

const SellerHandoff = require('./sellerHandoff');
const HumanControl = require('../services/humanControlStore');
const Identity = require('../services/contactIdentity');
const { resolvePhoneJid } = require('./lidServiceLabelFix');
const { findExactSellerLabel } = require('./vpsReadinessPreload');
const { env } = require('../config/env');
const { isTesterIdentity } = require('./testCommandAccess');

function normalizeChatId(value) {
  return Identity.normalizeChatId(value);
}

function uniqueIds(values = []) {
  return [...new Set(values.map(normalizeChatId).filter(Boolean))];
}

function findExistingHumanBlock(candidates = []) {
  for (const candidate of uniqueIds(candidates)) {
    const current = HumanControl.getBlock(candidate);
    if (current?.blocked) {
      return {
        chatId: candidate,
        control: current.control,
      };
    }
  }
  return null;
}

async function resolveSellerLabelCandidates(channel, clientId, options = {}) {
  const resolver = options.resolvePhoneJid || resolvePhoneJid;
  const direct = normalizeChatId(clientId);
  let knownBefore = [];
  try { knownBefore = Identity.getLabelCandidateIds(direct); } catch (_) {}

  let phoneJid = knownBefore.map(normalizeChatId).find((item) => item.endsWith('@c.us')) || null;
  let resolutionAttempted = false;

  if (direct.endsWith('@lid') && !phoneJid) {
    resolutionAttempted = true;
    try { phoneJid = normalizeChatId(await resolver(channel, direct)); } catch (_) { phoneJid = null; }
  }

  let knownAfter = [];
  try { knownAfter = Identity.getLabelCandidateIds(direct); } catch (_) {}

  const candidates = uniqueIds([direct, phoneJid, ...knownBefore, ...knownAfter]);
  const requiresPhoneResolution = direct.endsWith('@lid');
  const hasPhoneCandidate = candidates.some((item) => item.endsWith('@c.us'));

  return {
    candidates,
    direct,
    phoneJid: hasPhoneCandidate
      ? candidates.find((item) => item.endsWith('@c.us'))
      : null,
    resolutionAttempted,
    conclusiveIdentity: !requiresPhoneResolution || hasPhoneCandidate,
  };
}

function installSellerAliasHandoff() {
  if (SellerHandoff.__sellerAliasHandoffInstalled) return;

  const inspectChatLabels = SellerHandoff?._test?.inspectChatLabels;
  if (typeof inspectChatLabels !== 'function') return;

  SellerHandoff.detectSellerLabelAssignment = async function detectSellerAcrossAliases(channel, clientId) {
    if (isTesterIdentity({ from: clientId })) {
      return {
        assigned: false,
        source: 'tester_bypass',
        inspectionAvailable: true,
        chatFound: true,
        conclusive: true,
      };
    }

    if (!env.sellerLabelBlockingEnabled || !channel?.client) {
      return {
        assigned: false,
        source: 'disabled',
        inspectionAvailable: false,
        chatFound: false,
        conclusive: false,
      };
    }

    const resolution = await resolveSellerLabelCandidates(channel, clientId);
    let inspectionAvailable = false;
    let chatFound = false;
    let inspectedPhoneAlias = false;

    for (const chatId of resolution.candidates) {
      const inspection = await inspectChatLabels(channel.client, chatId);
      if (inspection?.available) inspectionAvailable = true;
      if (inspection?.chatFound) chatFound = true;
      if (chatId.endsWith('@c.us') && inspection?.available && inspection?.chatFound) {
        inspectedPhoneAlias = true;
      }

      const match = findExactSellerLabel(inspection?.items || []);
      if (match) {
        return {
          ...match,
          chatId,
          source: 'seller_label',
          inspectionAvailable,
          chatFound,
          conclusive: true,
          identityResolution: resolution,
        };
      }
    }

    const conclusive = inspectionAvailable
      && chatFound
      && resolution.conclusiveIdentity
      && (!resolution.direct.endsWith('@lid') || inspectedPhoneAlias);

    if (!conclusive && resolution.direct.endsWith('@lid')) {
      console.warn(
        `[HANDOFF] leitura de vendedor inconclusiva; automação não liberará bloqueio existente `
        + `| cliente=${clientId} | aliases=${resolution.candidates.join(',') || '-'}`,
      );
    }

    return {
      assigned: false,
      source: 'none',
      inspectionAvailable,
      chatFound,
      conclusive,
      identityResolution: resolution,
    };
  };

  SellerHandoff.getAutomationBlock = async function getAutomationBlockAcrossAliases(channel, clientId) {
    if (isTesterIdentity({ from: clientId })) {
      let aliases = [];
      try { aliases = Identity.getLabelCandidateIds(clientId); } catch (_) {}
      for (const candidate of uniqueIds([clientId, ...aliases])) {
        HumanControl.clearBlock(candidate);
      }
      return { blocked: false, reason: null, source: 'tester_bypass' };
    }

    const assignment = await SellerHandoff.detectSellerLabelAssignment(channel, clientId);
    const resolution = assignment?.identityResolution || await resolveSellerLabelCandidates(channel, clientId);

    if (assignment?.assigned) {
      HumanControl.setBlock(clientId, {
        reason: 'seller_label',
        source: 'seller_label',
        seller: assignment.seller,
        labelName: assignment.labelName,
        blockedHours: env.humanBlockHours,
      });

      return {
        blocked: true,
        reason: 'seller_label',
        seller: assignment.seller,
        labelName: assignment.labelName,
        source: assignment.source,
        details: assignment,
      };
    }

    const current = HumanControl.getBlock(clientId);
    const reason = String(current?.control?.reason || '');
    const inherited = current?.blocked ? null : findExistingHumanBlock(resolution.candidates);

    if (inherited?.control) {
      HumanControl.setBlock(clientId, {
        ...inherited.control,
        persistent: !inherited.control?.blockedUntil,
      });

      return {
        blocked: true,
        reason: inherited.control?.reason || 'human_block',
        seller: inherited.control?.seller || null,
        labelName: inherited.control?.labelName || null,
        source: inherited.control?.source || 'human_control',
        details: {
          inheritedFrom: inherited.chatId,
          identityResolution: resolution,
          control: inherited.control,
        },
      };
    }

    // Uma etiqueta removida só libera o bot após inspeção conclusiva de todos os
    // aliases necessários. Falha de resolução nunca é interpretada como remoção.
    if (current?.blocked && reason === 'seller_label' && assignment?.conclusive) {
      HumanControl.clearBlock(clientId);
      console.log(`[HANDOFF] etiqueta de vendedor removida em todos os aliases; automação liberada | cliente=${clientId}`);
      return { blocked: false, reason: null, source: 'seller_label_removed' };
    }

    if (current?.blocked) {
      return {
        blocked: true,
        reason: current.control?.reason || 'human_block',
        seller: current.control?.seller || null,
        labelName: current.control?.labelName || null,
        source: current.control?.source || 'human_control',
        details: current.control,
      };
    }

    return { blocked: false, reason: null };
  };

  SellerHandoff.__sellerAliasHandoffInstalled = true;
}

installSellerAliasHandoff();

module.exports = {
  installSellerAliasHandoff,
  normalizeChatId,
  resolveSellerLabelCandidates,
  uniqueIds,
};
