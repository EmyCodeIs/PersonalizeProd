'use strict';

const { env } = require('../config/env');
const Identity = require('../services/contactIdentity');

const HANDOFF_REASONS = new Set([
  'seller_label',
  'manual_label',
  'manual_outbound_message',
  'manual_outbound_history',
]);

function normalizeName(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeChatId(value) {
  try { return Identity.normalizeChatId(value); } catch (_) { return ''; }
}

function managedServiceLabelNames() {
  const names = [
    env.serviceLabelLetreiro,
    env.serviceLabelPlotagem,
    env.serviceLabelOutros,
    env.supportLabelName,
    env.awaitingQuoteLabelName,
    ...(Array.isArray(env.serviceLabelReplaceGroup) ? env.serviceLabelReplaceGroup : []),
  ];
  return new Set(names.map(normalizeName).filter(Boolean));
}

function sellerLabelNames() {
  return new Map(
    Object.keys(env.sellerLabelRules || {})
      .map((name) => [normalizeName(name), String(name || '').trim()])
      .filter(([normalized]) => normalized),
  );
}

function labelName(item) {
  if (typeof item === 'string') return item.trim();
  return String(item?.name || item?.label || '').trim();
}

function classifyLabelNames(items = []) {
  const managed = managedServiceLabelNames();
  const sellers = sellerLabelNames();
  const ignored = [];
  const candidates = [];

  for (const item of Array.isArray(items) ? items : Object.values(items || {})) {
    const name = labelName(item);
    const normalized = normalizeName(name);
    if (!normalized) continue;
    if (managed.has(normalized)) {
      ignored.push({ name, reason: 'managed_service_label' });
      continue;
    }
    candidates.push({ item, name, normalized });
  }

  for (const candidate of candidates) {
    const seller = sellers.get(candidate.normalized);
    if (!seller) continue;
    return {
      assigned: true,
      reason: 'seller_label',
      seller,
      labelName: candidate.name,
      labelId: String(candidate.item?.id?._serialized || candidate.item?.id || candidate.item?.labelId || ''),
      matchMode: 'exact_name',
      ignored,
    };
  }

  const external = candidates[0] || null;
  if (external) {
    return {
      assigned: true,
      reason: 'manual_label',
      seller: null,
      labelName: external.name,
      labelId: String(external.item?.id?._serialized || external.item?.id || external.item?.labelId || ''),
      matchMode: 'external_name',
      ignored,
    };
  }

  return {
    assigned: false,
    reason: ignored.length ? 'managed_service_labels_only' : 'no_named_external_label',
    ignored,
  };
}

function configuredTesterIdentities() {
  const split = (value) => String(value || '')
    .split(/[;,\n]/)
    .map((item) => item.trim())
    .filter(Boolean);

  const explicitTest = [
    ...split(process.env.TEST_COMMAND_ALLOWED_CLIENT_NUMBERS),
    ...split(process.env.TEST_COMMAND_ALLOWED_CHAT_IDS),
  ];
  const explicitAdmin = [
    ...split(process.env.ADMIN_WHATSAPP_NUMBERS),
    ...split(process.env.ADMIN_WHATSAPP_CHAT_IDS),
  ];
  return explicitTest.length ? explicitTest : explicitAdmin;
}

function onlyDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

function samePhone(left, right) {
  const a = onlyDigits(left);
  const b = onlyDigits(right);
  if (!a || !b) return false;
  if (a === b || a.endsWith(b) || b.endsWith(a)) return true;
  return a.slice(-11) === b.slice(-11);
}

function candidateIds(clientId) {
  const values = [clientId];
  try {
    if (typeof Identity.getLabelCandidateIds === 'function') {
      values.push(...Identity.getLabelCandidateIds(clientId));
    }
  } catch (_) {}

  const direct = normalizeChatId(clientId);
  const lidMap = env.lidNumberMap || {};
  if (direct.endsWith('@lid') && lidMap[direct]) {
    const mapped = onlyDigits(lidMap[direct]);
    if (mapped) values.push(`${mapped.length <= 11 ? `55${mapped}` : mapped}@c.us`);
  }
  if (direct.endsWith('@c.us')) {
    for (const [lid, phone] of Object.entries(lidMap)) {
      if (samePhone(direct, phone)) values.push(lid);
    }
  }

  return [...new Set(values.map(normalizeChatId).filter(Boolean))];
}

function isStrictTesterIdentity({ from, raw } = {}) {
  const configured = configuredTesterIdentities();
  if (!configured.length) return false;

  const values = [
    from,
    raw?.from,
    raw?.to,
    raw?.chatId,
    raw?.sender?.id,
    raw?.sender?.id?._serialized,
    raw?.contact?.id,
    raw?.contact?.id?._serialized,
    raw?.id?.remote,
    raw?.key?.remoteJid,
    raw?.key?.participant,
  ];
  for (const value of [...values, ...candidateIds(from)]) {
    const serialized = value && typeof value === 'object'
      ? String(value._serialized || value.id?._serialized || value.id || '').trim()
      : String(value || '').trim();
    if (!serialized) continue;
    for (const allowed of configured) {
      if (serialized.toLowerCase() === String(allowed).trim().toLowerCase()) return true;
      if (samePhone(serialized, allowed)) return true;
    }
  }
  return false;
}

function isSupportedHandoffReason(reason) {
  return HANDOFF_REASONS.has(String(reason || '').trim());
}

module.exports = {
  HANDOFF_REASONS,
  candidateIds,
  classifyLabelNames,
  configuredTesterIdentities,
  isStrictTesterIdentity,
  isSupportedHandoffReason,
  labelName,
  managedServiceLabelNames,
  normalizeName,
  samePhone,
  sellerLabelNames,
};
