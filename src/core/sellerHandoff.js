'use strict';

const Identity = require('../services/contactIdentity');
const HumanControl = require('../services/humanControlStore');
const { env } = require('../config/env');

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
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function desiredHex(color) {
  const raw = String(color || '').trim();
  if (/^#[0-9a-f]{6}$/i.test(raw)) return raw.toLowerCase();
  return COLOR_HEX[normalizeName(raw)] || null;
}

function managedServiceLabelNames() {
  return [
    env.serviceLabelLetreiro,
    env.serviceLabelPlotagem,
    env.serviceLabelOutros,
    ...(Array.isArray(env.serviceLabelReplaceGroup) ? env.serviceLabelReplaceGroup : []),
  ]
    .map((item) => normalizeName(item))
    .filter(Boolean);
}

function orderedCandidateIds(clientId) {
  const direct = Identity.normalizeChatId(clientId);
  const known = typeof Identity.getLabelCandidateIds === 'function'
    ? Identity.getLabelCandidateIds(clientId)
    : [];
  return [...new Set([direct, ...known].filter(Boolean))];
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
        if (WPP?.labels?.getLabelColorPalette) {
          palette = await WPP.labels.getLabelColorPalette();
        }
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
  } catch (err) {
    console.warn(`[HANDOFF] não foi possível inspecionar etiquetas de ${chatId}:`, err?.message || err);
    return { available: false, chatFound: null, items: [] };
  }
}

function findSellerLabelMatch(items = []) {
  const managed = new Set(managedServiceLabelNames());
  const rules = Object.entries(env.sellerLabelRules || {});

  for (const item of items) {
    const labelName = String(item?.name || '').trim();
    const normalizedLabelName = normalizeName(labelName);
    if (!labelName || managed.has(normalizedLabelName)) continue;

    for (const [sellerKey, sellerColor] of rules) {
      const normalizedSeller = normalizeName(sellerKey);
      const labelHex = String(item?.hexColor || '').trim().toLowerCase();
      const labelColorIndex = Number.isFinite(Number(item?.colorIndex)) ? Number(item.colorIndex) : null;
      // Vendedor é reconhecido somente pelo nome exato. Cor serve para criação
      // e conferência visual, nunca como identidade, pois etiquetas manuais podem
      // compartilhar a mesma cor (por exemplo, Fornecedor e C. Eduardo).
      const byExactName = Boolean(normalizedSeller && normalizedLabelName === normalizedSeller);

      if (byExactName) {
        return {
          assigned: true,
          reason: 'seller_label',
          seller: sellerKey,
          sellerColor,
          labelName,
          labelId: String(item?.id || ''),
          labelHex: labelHex || null,
          labelColorIndex,
          matchMode: 'name',
        };
      }
    }

    return {
      assigned: true,
      reason: 'manual_label',
      seller: null,
      sellerColor: null,
      labelName,
      labelId: String(item?.id || ''),
      labelHex: String(item?.hexColor || '').trim().toLowerCase() || null,
      labelColorIndex: Number.isFinite(Number(item?.colorIndex)) ? Number(item.colorIndex) : null,
      matchMode: 'manual_label',
    };
  }

  return null;
}

async function detectSellerLabelAssignment(channel, clientId) {
  if (!env.sellerLabelBlockingEnabled || !channel?.client) {
    return { assigned: false, source: 'disabled' };
  }

  const candidates = orderedCandidateIds(clientId);
  for (const chatId of candidates) {
    const inspection = await inspectChatLabels(channel.client, chatId);
    const match = findSellerLabelMatch(inspection.items || []);
    if (match) return { ...match, chatId, source: 'seller_label' };
  }

  return { assigned: false, source: 'none' };
}

function registerManualTakeover(clientId, payload = {}) {
  return HumanControl.setBlock(clientId, {
    reason: payload.reason || 'manual_outbound_message',
    source: payload.source || 'manual_outbound_message',
    seller: payload.seller || null,
    labelName: payload.labelName || null,
    blockedHours: payload.blockedHours || env.humanBlockHours,
  });
}

async function getAutomationBlock(channel, clientId) {
  const sellerAssignment = await detectSellerLabelAssignment(channel, clientId);
  if (sellerAssignment.assigned) {
    HumanControl.setBlock(clientId, {
      reason: sellerAssignment.reason || 'seller_label',
      source: sellerAssignment.source || sellerAssignment.reason || 'seller_label',
      seller: sellerAssignment.seller,
      labelName: sellerAssignment.labelName,
      blockedHours: env.humanBlockHours,
    });

    return {
      blocked: true,
      reason: sellerAssignment.reason || 'seller_label',
      seller: sellerAssignment.seller,
      labelName: sellerAssignment.labelName,
      source: sellerAssignment.source,
      details: sellerAssignment,
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

  return { blocked: false, reason: null };
}

module.exports = {
  detectSellerLabelAssignment,
  getAutomationBlock,
  registerManualTakeover,
  _test: {
    desiredHex,
    findSellerLabelMatch,
    inspectChatLabels,
    managedServiceLabelNames,
    normalizeName,
    orderedCandidateIds,
  },
};
