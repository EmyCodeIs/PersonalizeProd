'use strict';

const Identity = require('../services/contactIdentity');
const HumanControl = require('../services/humanControlStore');
const { env } = require('../config/env');
const LabelPolicy = require('./labelPolicy');
const { resolvePhoneJid } = require('./lidServiceLabelFix');

const COLOR_HEX = Object.freeze({
  green: '#00a884',
  red: '#ea0038',
  gray: '#667781',
  grey: '#667781',
  blue: '#027eb5',
  yellow: '#f7b928',
  orange: '#ff7a00',
  purple: '#7f66ff',
  pink: '#ff7eb6',
});

let secondaryGuard = null;

function hexToRgb(hex) {
  const clean = String(hex || '').replace('#', '').trim();
  if (!/^[0-9a-f]{6}$/i.test(clean)) return null;
  return [
    parseInt(clean.slice(0, 2), 16),
    parseInt(clean.slice(2, 4), 16),
    parseInt(clean.slice(4, 6), 16),
  ];
}

function candidateHexFromPalette(entry) {
  return typeof entry === 'string'
    ? entry
    : (entry?.hex || entry?.hexColor || entry?.color || entry?.value || '');
}

function nearestPaletteIndex(palette, requestedHex) {
  const wanted = hexToRgb(requestedHex);
  if (!wanted || !Array.isArray(palette) || !palette.length) return null;

  let bestIndex = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  palette.forEach((entry, index) => {
    const candidate = hexToRgb(candidateHexFromPalette(entry));
    if (!candidate) return;
    const distance = ((candidate[0] - wanted[0]) ** 2)
      + ((candidate[1] - wanted[1]) ** 2)
      + ((candidate[2] - wanted[2]) ** 2);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  });

  return Number.isInteger(bestIndex) ? bestIndex : null;
}

function normalizeName(value) {
  return LabelPolicy.normalizeName(value);
}

function desiredHex(color) {
  const raw = String(color || '').trim();
  if (/^#[0-9a-f]{6}$/i.test(raw)) return raw.toLowerCase();
  return COLOR_HEX[normalizeName(raw)] || null;
}

function managedServiceLabelNames() {
  return [...LabelPolicy.operationalLabelNames()];
}

function normalizeChatId(value) {
  return Identity.normalizeChatId(value);
}

function orderedCandidateIds(clientId) {
  const direct = normalizeChatId(clientId);
  const known = typeof Identity.getLabelCandidateIds === 'function'
    ? Identity.getLabelCandidateIds(clientId)
    : [];
  return [...new Set([direct, ...known.map(normalizeChatId)].filter(Boolean))];
}

async function resolveLabelCandidates(channel, clientId, options = {}) {
  const resolver = options.resolvePhoneJid || resolvePhoneJid;
  const direct = normalizeChatId(clientId);
  const before = orderedCandidateIds(direct);
  let phoneJid = before.find((item) => item.endsWith('@c.us')) || null;
  let resolutionAttempted = false;

  if (direct.endsWith('@lid') && !phoneJid) {
    resolutionAttempted = true;
    try { phoneJid = normalizeChatId(await resolver(channel, direct)); } catch (_) { phoneJid = null; }
  }

  const after = orderedCandidateIds(direct);
  const candidates = [...new Set([direct, phoneJid, ...before, ...after].filter(Boolean))];
  const hasPhoneCandidate = candidates.some((item) => item.endsWith('@c.us'));

  return {
    direct,
    phoneJid: hasPhoneCandidate ? candidates.find((item) => item.endsWith('@c.us')) : null,
    candidates,
    resolutionAttempted,
    conclusiveIdentity: !direct.endsWith('@lid') || hasPhoneCandidate,
  };
}

async function inspectChatLabels(client, chatId) {
  if (!client?.page?.evaluate || !chatId) return { available: false, chatFound: null, items: [] };

  try {
    return await client.page.evaluate(async ({ chatId }) => {
      const WPP = window.WPP || null;
      const Store = window.Store || null;
      let chat = null;

      try {
        chat = Store?.Chat?.get?.(chatId) || null;
        if (!chat && typeof Store?.Chat?.find === 'function') chat = await Store.Chat.find(chatId);
      } catch (_) {}

      if (!chat) return { available: true, chatFound: false, items: [] };

      let all = [];
      try {
        if (WPP?.labels?.getAllLabels) {
          const value = await WPP.labels.getAllLabels();
          all = Array.isArray(value) ? value : Object.values(value || {});
        }
      } catch (_) {}

      let palette = [];
      try {
        if (WPP?.labels?.getLabelColorPalette) palette = await WPP.labels.getLabelColorPalette();
      } catch (_) {}

      const labelStore = Store?.Label || Store?.Labels || null;
      if (typeof labelStore?.getLabelsForModel !== 'function') {
        return { available: false, chatFound: true, items: [] };
      }

      let attached = [];
      try {
        const value = labelStore.getLabelsForModel(chat) || [];
        attached = Array.isArray(value) ? value : Object.values(value || {});
      } catch (_) {}

      const items = attached.map((entry) => {
        const id = String(entry?.id?._serialized || entry?.id || entry?.labelId || entry || '');
        const known = all.find((item) => String(item?.id || item?.labelId || '') === id) || null;
        const colorIndex = entry?.colorIndex ?? entry?.colorId ?? entry?.color
          ?? known?.colorIndex ?? known?.colorId ?? known?.color ?? null;
        const paletteEntry = Number.isInteger(Number(colorIndex)) ? palette[Number(colorIndex)] : null;
        return {
          id,
          name: String(entry?.name || entry?.label || known?.name || known?.label || ''),
          colorIndex,
          hexColor: String(entry?.hexColor || known?.hexColor || paletteEntry?.hex || paletteEntry?.hexColor || paletteEntry?.color || paletteEntry?.value || ''),
        };
      }).filter((item) => item.id || item.name);

      return { available: true, chatFound: true, items };
    }, { chatId });
  } catch (error) {
    console.warn(`[HANDOFF] não foi possível inspecionar etiquetas de ${chatId}:`, error?.message || error);
    return { available: false, chatFound: null, items: [] };
  }
}

function findSellerLabelMatch(items = []) {
  const match = LabelPolicy.firstBlockingLabel(items);
  if (!match) return null;
  const item = match.label || {};
  const labelColorIndex = Number.isFinite(Number(item?.colorIndex)) ? Number(item.colorIndex) : null;

  return {
    assigned: true,
    reason: match.reason,
    seller: match.seller,
    sellerColor: match.seller ? env.sellerLabelRules?.[match.seller] || null : null,
    labelName: match.name,
    labelId: String(item?.id || ''),
    labelHex: String(item?.hexColor || '').trim().toLowerCase() || null,
    labelColorIndex,
    matchMode: match.category === LabelPolicy.LABEL_CATEGORY.SELLER ? 'name' : 'manual_label',
    category: match.category,
  };
}

async function detectSellerLabelAssignment(channel, clientId) {
  if (!env.sellerLabelBlockingEnabled || !channel?.client) {
    return {
      assigned: false,
      source: 'disabled',
      inspectionAvailable: false,
      chatFound: false,
      conclusive: false,
    };
  }

  const resolution = await resolveLabelCandidates(channel, clientId);
  let inspectionAvailable = false;
  let chatFound = false;
  let inspectedPhoneAlias = false;

  for (const chatId of resolution.candidates) {
    const inspection = await inspectChatLabels(channel.client, chatId);
    if (inspection?.available) inspectionAvailable = true;
    if (inspection?.chatFound) chatFound = true;
    if (chatId.endsWith('@c.us') && inspection?.available && inspection?.chatFound) inspectedPhoneAlias = true;

    const match = findSellerLabelMatch(inspection?.items || []);
    if (match) {
      return {
        ...match,
        chatId,
        source: match.reason,
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
      `[HANDOFF] leitura de etiquetas inconclusiva; bloqueio existente será preservado `
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
}

function setSecondaryGuard(handler) {
  secondaryGuard = typeof handler === 'function' ? handler : null;
  return secondaryGuard;
}

async function getAutomationBlock(channel, clientId) {
  const assignment = await detectSellerLabelAssignment(channel, clientId);

  if (assignment?.assigned) {
    HumanControl.setBlock(clientId, {
      reason: assignment.reason,
      source: assignment.source,
      seller: assignment.seller,
      labelName: assignment.labelName,
      persistent: true,
      blockedHours: env.humanBlockHours,
    });

    return {
      blocked: true,
      reason: assignment.reason,
      seller: assignment.seller,
      labelName: assignment.labelName,
      source: assignment.source,
      details: assignment,
    };
  }

  const humanControl = HumanControl.getBlock(clientId);
  if (humanControl?.blocked) {
    return {
      blocked: true,
      reason: humanControl.control?.reason || 'human_block',
      seller: humanControl.control?.seller || null,
      labelName: humanControl.control?.labelName || null,
      source: humanControl.control?.source || 'human_control',
      details: humanControl.control,
    };
  }

  if (secondaryGuard) {
    const result = await secondaryGuard(channel, clientId, assignment);
    if (result?.blocked) return result;
  }

  return { blocked: false, reason: null, details: assignment };
}

function registerManualTakeover(clientId, payload = {}) {
  return HumanControl.setBlock(clientId, {
    reason: payload.reason || 'manual_outbound_message',
    source: payload.source || 'manual_outbound_message',
    seller: payload.seller || null,
    labelName: payload.labelName || null,
    persistent: true,
    blockedHours: payload.blockedHours || env.humanBlockHours,
  });
}

module.exports = {
  detectSellerLabelAssignment,
  getAutomationBlock,
  registerManualTakeover,
  resolveLabelCandidates,
  setSecondaryGuard,
  _test: {
    desiredHex,
    findSellerLabelMatch,
    inspectChatLabels,
    managedServiceLabelNames,
    nearestPaletteIndex,
    normalizeName,
    orderedCandidateIds,
    resolveLabelCandidates,
  },
};
