'use strict';

const path = require('path');
const { env } = require('../config/env');
const Persistence = require('./persistence');

const DATA_DIR = path.join(process.cwd(), 'data');
const IDENTITIES_PATH = path.join(DATA_DIR, 'contact-identities.json');

function readState() {
  const parsed = Persistence.readJson(IDENTITIES_PATH, { contacts: {}, aliases: {}, updatedAt: null });
  return {
    contacts: parsed?.contacts && typeof parsed.contacts === 'object' ? parsed.contacts : {},
    aliases: parsed?.aliases && typeof parsed.aliases === 'object' ? parsed.aliases : {},
    updatedAt: parsed?.updatedAt || null,
  };
}

const state = readState();

function saveState() {
  state.updatedAt = new Date().toISOString();
  Persistence.writeJson(IDENTITIES_PATH, state);
}

function normalizeChatId(value) {
  const serialized = value && typeof value === 'object'
    ? (value._serialized || value.id?._serialized || value.id || '')
    : value;
  const raw = String(serialized || '').trim().toLowerCase();
  if (!raw) return '';
  if (/@(c\.us|g\.us|lid)$/i.test(raw)) return raw;
  const digits = raw.replace(/\D/g, '');
  return digits ? `${digits}@c.us` : '';
}

function onlyDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

function normalizePhone(value) {
  let digits = onlyDigits(value);
  if (!digits) return null;
  if (digits.length === 10 || digits.length === 11) digits = `55${digits}`;
  return digits;
}

function collectRawAliases({ chatId, raw, phone } = {}) {
  const sender = raw?.sender || raw?.contact || raw?.chat || {};
  const values = [
    chatId,
    raw?.from,
    raw?.chatId,
    raw?.author,
    raw?.to,
    raw?.id?.remote,
    raw?.key?.remoteJid,
    raw?.key?.participant,
    sender?.id,
    sender?.id?._serialized,
    sender?.number,
    sender?.phone,
    sender?.userid,
  ];

  const normalizedPhone = normalizePhone(phone || sender?.number || sender?.phone || sender?.userid);
  if (normalizedPhone) values.push(normalizedPhone, `${normalizedPhone}@c.us`);

  return [...new Set(values.map(normalizeChatId).filter(Boolean))];
}

function findContactKey(alias) {
  const normalized = normalizeChatId(alias);
  if (!normalized) return null;
  return state.aliases[normalized] || null;
}

function chooseContactKey(aliases) {
  for (const alias of aliases) {
    const existing = findContactKey(alias);
    if (existing) return existing;
  }
  const primary = aliases.find((alias) => alias.endsWith('@lid'))
    || aliases.find((alias) => alias.endsWith('@c.us'))
    || aliases[0];
  return primary ? `wa:${primary}` : null;
}

function registerContact({ chatId, raw, phone } = {}) {
  const aliases = collectRawAliases({ chatId, raw, phone });
  if (!aliases.length) return null;

  const contactKey = chooseContactKey(aliases);
  if (!contactKey) return null;

  const existing = state.contacts[contactKey] || {
    contactKey,
    primaryChatId: aliases[0],
    aliases: [],
    lid: null,
    cUsId: null,
    phone: null,
    createdAt: new Date().toISOString(),
  };

  const mergedAliases = [...new Set([...(existing.aliases || []), ...aliases])];
  existing.aliases = mergedAliases;
  existing.primaryChatId = normalizeChatId(chatId) || existing.primaryChatId || mergedAliases[0];
  existing.lid = mergedAliases.find((alias) => alias.endsWith('@lid')) || existing.lid || null;
  existing.cUsId = mergedAliases.find((alias) => alias.endsWith('@c.us')) || existing.cUsId || null;
  existing.phone = normalizePhone(phone)
    || normalizePhone(existing.cUsId)
    || existing.phone
    || null;
  existing.updatedAt = new Date().toISOString();

  state.contacts[contactKey] = existing;
  for (const alias of mergedAliases) state.aliases[alias] = contactKey;

  const lidMap = env.lidNumberMap || {};
  if (existing.lid && lidMap[existing.lid]) {
    const mappedPhone = normalizePhone(lidMap[existing.lid]);
    if (mappedPhone) {
      existing.phone = existing.phone || mappedPhone;
      existing.cUsId = existing.cUsId || `${mappedPhone}@c.us`;
      if (!existing.aliases.includes(existing.cUsId)) existing.aliases.push(existing.cUsId);
      state.aliases[existing.cUsId] = contactKey;
    }
  }

  saveState();
  return { ...existing };
}

function resolveContact(value) {
  const normalized = normalizeChatId(value);
  const contactKey = findContactKey(normalized) || (normalized ? `wa:${normalized}` : null);
  if (!contactKey) return null;
  const contact = state.contacts[contactKey];
  if (contact) return { ...contact };
  return {
    contactKey,
    primaryChatId: normalized,
    aliases: normalized ? [normalized] : [],
    lid: normalized?.endsWith('@lid') ? normalized : null,
    cUsId: normalized?.endsWith('@c.us') ? normalized : null,
    phone: normalizePhone(normalized),
  };
}

function getSessionKey(value) {
  return resolveContact(value)?.contactKey || `wa:${normalizeChatId(value)}`;
}

function getLabelCandidateIds(value) {
  const contact = resolveContact(value);
  if (!contact) return [normalizeChatId(value)].filter(Boolean);
  return [...new Set([
    contact.primaryChatId,
    contact.lid,
    contact.cUsId,
    ...(contact.aliases || []),
  ].map(normalizeChatId).filter(Boolean))];
}

function resetIdentities() {
  const previousCount = Object.keys(state.contacts).length;
  state.contacts = {};
  state.aliases = {};
  saveState();
  return previousCount;
}

module.exports = {
  normalizeChatId,
  normalizePhone,
  registerContact,
  resolveContact,
  getSessionKey,
  getLabelCandidateIds,
  resetIdentities,
};
