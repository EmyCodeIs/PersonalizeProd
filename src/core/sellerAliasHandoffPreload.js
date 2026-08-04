'use strict';

const SellerHandoff = require('./sellerHandoff');
const HumanControl = require('../services/humanControlStore');
const Identity = require('../services/contactIdentity');
const { resolvePhoneJid } = require('./lidServiceLabelFix');
require('./vpsReadinessPreload');
const { env } = require('../config/env');

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
  const findLabelBlockMatch = SellerHandoff?._test?.findSellerLabelMatch;
  if (typeof inspectChatLabels !== 'function' || typeof findLabelBlockMatch !== 'function') return;

  SellerHandoff.detectSellerLabelAssignment = async function detectLabelsAcrossAliases(channel, clientId) {
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

      const match = findLabelBlockMatch(inspection?.items || []);
      if (match) {
        return {
          ...match,
          chatId,
          source: match.reason === 'manual_label' ? 'manual_label' : 'seller_label',
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
        `[HANDOFF] leitura de etiquetas inconclusiva; automação manterá qualquer bloqueio existente `
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
    const assignment = await SellerHandoff.detectSellerLabelAssignment(channel, clientId);
    const resolution = assignment?.identityResolution || await resolveSellerLabelCandidates(channel, clientId);

    if (assignment?.assigned) {
      const reason = assignment.reason || 'seller_label';
      const source = assignment.source || reason;

      HumanControl.setBlock(clientId, {
        reason,
        source,
        seller: assignment.seller,
        labelName: assignment.labelName,
        persistent: true,
        blockedHours: env.humanBlockHours,
      });

      return {
        blocked: true,
        reason,
        seller: assignment.seller,
        labelName: assignment.labelName,
        source,
        details: assignment,
      };
    }

    const current = HumanControl.getBlock(clientId);
    const reason = String(current?.control?.reason || '');
    const inherited = current?.blocked ? null : findExistingHumanBlock(resolution.candidates);

    if (inherited?.control) {
      HumanControl.setBlock(clientId, {
        ...inherited.control,
        persistent: true,
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

    if (current?.blocked) {
      if (assignment?.conclusive && ['seller_label', 'manual_label'].includes(reason)) {
        console.log(
          `[HANDOFF] etiqueta externa não está mais visível; bloqueio persistente mantido `
          + `| cliente=${clientId} | motivo=${reason}`,
        );
      }

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
