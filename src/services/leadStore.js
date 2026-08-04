'use strict';

const path = require('path');
const Identity = require('./contactIdentity');
const Persistence = require('./persistence');
const { env } = require('../config/env');

const DATA_DIR = path.join(process.cwd(), 'data');
const SESSIONS_PATH = path.join(DATA_DIR, 'sessions.json');
const LEADS_PATH = path.join(DATA_DIR, 'leads.jsonl');
const PROFILES_PATH = path.join(DATA_DIR, 'profiles.json');

function readJson(filePath, fallback) {
  return Persistence.readJson(filePath, fallback);
}

function writeJson(filePath, data) {
  return Persistence.writeJson(filePath, data);
}

const state = readJson(SESSIONS_PATH, { sessions: {}, lastSavedAt: null });
if (!state.sessions || typeof state.sessions !== 'object') state.sessions = {};

const profileState = readJson(PROFILES_PATH, { profiles: {}, lastSavedAt: null });
if (!profileState.profiles || typeof profileState.profiles !== 'object') profileState.profiles = {};

function nowIso() {
  return new Date().toISOString();
}

function toFiniteTimestamp(value) {
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function addHoursIso(baseIso, hours) {
  const baseTimestamp = toFiniteTimestamp(baseIso) || Date.now();
  const safeHours = Math.max(1, Number(hours || 0));
  return new Date(baseTimestamp + (safeHours * 60 * 60 * 1000)).toISOString();
}

function computeExpiresAt(lastInteractionAt, completed = false) {
  const ttlHours = completed
    ? env.completedSessionTtlHours
    : env.flowSessionTtlHours;
  return addHoursIso(lastInteractionAt || nowIso(), ttlHours);
}

function sanitizeProfileName(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 120) || null;
}

function cleanText(value, maxLength = 160) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, maxLength) : null;
}

function cleanOptionalList(values = [], maxItems = 5, maxLength = 60) {
  if (!Array.isArray(values)) return [];
  const out = [];
  for (const item of values) {
    const text = cleanText(item, maxLength);
    if (!text || out.includes(text)) continue;
    out.push(text);
    if (out.length >= maxItems) break;
  }
  return out;
}

function normalizeClientId(clientId) {
  return Identity.getSessionKey(clientId);
}

function createSession(id, chatId) {
  const identity = Identity.resolveContact(chatId || id);
  const createdAt = nowIso();
  return {
    id,
    clientId: id,
    chatId: identity?.primaryChatId || String(chatId || '').trim() || null,
    contactIdentity: identity || null,
    etapa: 'inicio',
    dados: {},
    createdAt,
    updatedAt: createdAt,
    lastInteractionAt: createdAt,
    expiresAt: computeExpiresAt(createdAt, false),
    completed: false,
    completedAt: null,
  };
}

function migrateSession(session, id, chatId) {
  const next = session && typeof session === 'object' ? session : createSession(id, chatId);
  const identity = Identity.resolveContact(chatId || next.chatId || id);
  next.id = id;
  next.clientId = id;
  next.chatId = identity?.primaryChatId || next.chatId || String(chatId || '').trim() || null;
  next.contactIdentity = identity || next.contactIdentity || null;
  next.etapa = next.etapa || next.step || 'inicio';
  next.dados = next.dados || next.data || {};
  next.createdAt = next.createdAt || nowIso();
  next.updatedAt = next.updatedAt || next.lastInteractionAt || next.createdAt || nowIso();
  next.lastInteractionAt = next.lastInteractionAt || next.updatedAt || next.createdAt || nowIso();
  next.completed = Boolean(next.completed || next.dados?.botDone || next.etapa === 'concluido');
  next.completedAt = next.completed
    ? (next.completedAt || next.dados?.completedAt || next.updatedAt || next.lastInteractionAt)
    : null;
  next.expiresAt = next.expiresAt || computeExpiresAt(next.lastInteractionAt, next.completed);
  return next;
}

function createCustomerProfile(id, payload = {}) {
  const createdAt = nowIso();
  return {
    clientId: id,
    firstSeenAt: createdAt,
    lastSeenAt: createdAt,
    visitCount: 0,
    knownName: sanitizeProfileName(payload.name),
    createdAt,
    updatedAt: createdAt,
  };
}

function migrateCustomerProfile(profile, id) {
  const next = profile && typeof profile === 'object' ? profile : createCustomerProfile(id);
  next.clientId = id;
  next.firstSeenAt = next.firstSeenAt || next.createdAt || nowIso();
  next.lastSeenAt = next.lastSeenAt || next.updatedAt || next.firstSeenAt || nowIso();
  next.visitCount = Math.max(0, Number(next.visitCount || 0));
  next.knownName = sanitizeProfileName(next.knownName || next.name);
  next.createdAt = next.createdAt || next.firstSeenAt;
  next.updatedAt = next.updatedAt || next.lastSeenAt;
  return next;
}

function isSessionExpired(session, currentTime = Date.now()) {
  const expiresAt = toFiniteTimestamp(session?.expiresAt);
  if (!expiresAt) return false;
  return expiresAt <= currentTime;
}

function persistState() {
  state.lastSavedAt = nowIso();
  writeJson(SESSIONS_PATH, state);
}

function persistProfiles() {
  profileState.lastSavedAt = nowIso();
  writeJson(PROFILES_PATH, profileState);
}

function purgeExpiredSessions({ write = true } = {}) {
  const currentTime = Date.now();
  let changed = false;

  for (const [id, session] of Object.entries(state.sessions || {})) {
    const migrated = migrateSession(session, id, session?.chatId || session?.clientId || id);
    if (isSessionExpired(migrated, currentTime)) {
      delete state.sessions[id];
      changed = true;
      continue;
    }

    if (state.sessions[id] !== migrated) {
      state.sessions[id] = migrated;
      changed = true;
    }
  }

  if (changed && write) persistState();
  return changed;
}

function getSession(clientId) {
  const id = normalizeClientId(clientId);
  if (!id) return null;

  const previous = state.sessions[id];
  const migrated = migrateSession(previous, id, clientId);
  if (previous && isSessionExpired(migrated)) {
    state.sessions[id] = createSession(id, clientId);
    persistState();
    return state.sessions[id];
  }

  state.sessions[id] = migrated;
  return state.sessions[id];
}

function saveSession(session) {
  if (!session?.clientId && !session?.id && !session?.chatId) return null;
  const sourceId = session.chatId || session.clientId || session.id;
  const id = normalizeClientId(sourceId);
  const next = migrateSession(session, id, sourceId);
  const updatedAt = nowIso();
  next.updatedAt = updatedAt;
  next.lastInteractionAt = updatedAt;
  next.completed = Boolean(next.completed || next.dados?.botDone || next.etapa === 'concluido');
  next.completedAt = next.completed
    ? (next.completedAt || next.dados?.completedAt || updatedAt)
    : null;
  next.expiresAt = computeExpiresAt(updatedAt, next.completed);
  state.sessions[id] = next;
  persistState();
  return next;
}

function resetSession(clientId) {
  const id = normalizeClientId(clientId);
  if (!id) return null;
  state.sessions[id] = createSession(id, clientId);
  persistState();
  return state.sessions[id];
}

function resetConversation(clientId, options = {}) {
  const id = normalizeClientId(clientId);
  if (!id) return null;

  const hadSession = Boolean(state.sessions[id]);
  const hadProfile = Boolean(profileState.profiles[id]);
  delete state.sessions[id];
  if (options.clearProfile !== false) delete profileState.profiles[id];

  state.sessions[id] = createSession(id, clientId);
  persistState();
  if (options.clearProfile !== false) persistProfiles();

  return {
    session: state.sessions[id],
    removedSession: hadSession,
    removedProfile: options.clearProfile !== false && hadProfile,
  };
}

function getCustomerProfile(clientId) {
  const id = normalizeClientId(clientId);
  if (!id) return null;
  const existing = profileState.profiles[id];
  if (!existing) return null;
  const migrated = migrateCustomerProfile(existing, id);
  profileState.profiles[id] = migrated;
  return migrated;
}

function rememberCustomerProfile(clientId, payload = {}) {
  const id = normalizeClientId(clientId);
  if (!id) return null;

  const existing = profileState.profiles[id];
  const next = migrateCustomerProfile(existing, id);
  const timestamp = payload.seenAt || nowIso();
  next.lastSeenAt = timestamp;
  next.updatedAt = timestamp;
  if (!next.firstSeenAt) next.firstSeenAt = timestamp;
  const nextName = sanitizeProfileName(payload.name);
  if (nextName) next.knownName = nextName;
  if (!existing && next.visitCount < 1) next.visitCount = 1;
  profileState.profiles[id] = next;
  persistProfiles();
  return next;
}

function beginCustomerConversation(clientId, payload = {}) {
  const id = normalizeClientId(clientId);
  if (!id) return { profile: null, isReturning: false };

  const existing = getCustomerProfile(id);
  const next = migrateCustomerProfile(existing, id);
  const timestamp = payload.seenAt || nowIso();
  next.lastSeenAt = timestamp;
  next.updatedAt = timestamp;
  next.visitCount = Math.max(0, Number(next.visitCount || 0)) + 1;
  const nextName = sanitizeProfileName(payload.name);
  if (nextName) next.knownName = nextName;
  profileState.profiles[id] = next;
  persistProfiles();

  return {
    profile: next,
    isReturning: Boolean(existing && Number(existing.visitCount || 0) >= 1),
  };
}

function listCustomerProfiles() {
  return Object.entries(profileState.profiles || {}).map(([id, profile]) => (
    migrateCustomerProfile(profile, id)
  ));
}

function buildCompactLead(payload = {}) {
  const dados = payload?.dados && typeof payload.dados === 'object' ? payload.dados : {};
  const demanda = dados?.demanda && typeof dados.demanda === 'object' ? dados.demanda : {};
  const medias = Array.isArray(dados.arteMedias) ? dados.arteMedias : [];
  const city = cleanText(dados.cidade, 120);
  const service = cleanText(dados.flow || payload.service, 40);
  const summary = {
    origin: cleanText(dados.origem, 40),
    customerName: cleanText(dados.nome, 120),
    phone: cleanText(dados.telefone, 40),
    city,
    service,
    demandDescription: cleanText(demanda.descricao, 240),
    demandMeasure: cleanText(demanda.medida, 120),
    demandLocation: cleanText(demanda.local, 120),
    demandReference: cleanText(demanda.referencia, 160),
    demandDeadline: cleanText(demanda.prazo, 120),
    acrylicType: cleanText(dados.tipoAcrilico, 40),
    pantoneDescription: cleanText(dados.pantoneDescricao, 160),
    colorCount: Number.isFinite(Number(dados.corBasicaQtd)) ? Number(dados.corBasicaQtd) : null,
    colors: cleanOptionalList(dados.coresSelecionadas, 5, 60),
    measureMode: cleanText(dados.tamanhoModo, 40),
    measureDescription: cleanText(dados.tamanhoDescricao, 160),
    widthCm: Number.isFinite(Number(dados?.medida?.largura)) ? Number(dados.medida.largura) : null,
    heightCm: Number.isFinite(Number(dados?.medida?.altura)) ? Number(dados.medida.altura) : null,
    thickness: cleanText(dados.espessura, 60),
    extraAcrylic: cleanText(dados.acrescimoAcrilico, 40),
    deliveryMethod: cleanText(dados.envio, 40),
    hasAddress: Boolean(cleanText(dados.endereco, 20)),
    artMode: cleanText(dados.arteModo, 40),
    artDescription: cleanText(dados.arteTexto, 240),
    artMediaCount: medias.length || 0,
    observation: cleanText(dados.observacaoPedido, 240),
  };

  return {
    id: `lead_${Date.now()}_${Math.random().toString(16).slice(2)}`,
    createdAt: nowIso(),
    clientId: payload.clientId ? normalizeClientId(payload.clientId) : null,
    reason: cleanText(payload.reason, 80),
    stage: cleanText(payload.etapa, 60),
    completedAt: cleanText(dados.completedAt || payload.completedAt, 80) || nowIso(),
    customerProfile: payload.clientId ? getCustomerProfile(payload.clientId) : null,
    summary,
  };
}

function appendLead(payload = {}) {
  const lead = buildCompactLead(payload);
  Persistence.appendJsonLine(LEADS_PATH, lead);
  return lead;
}

function listSessions() {
  purgeExpiredSessions();
  return Object.entries(state.sessions || {}).map(([id, session]) => (
    migrateSession(session, id, session?.chatId || session?.clientId || id)
  ));
}

function resetSystem() {
  const previousSessionCount = Object.keys(state.sessions || {}).length;
  const previousProfileCount = Object.keys(profileState.profiles || {}).length;
  const previousLeadCount = Persistence.countJsonLines(LEADS_PATH);

  state.sessions = {};
  persistState();

  profileState.profiles = {};
  persistProfiles();

  Persistence.clearJsonLines(LEADS_PATH);
  const previousIdentityCount = Identity.resetIdentities();

  return {
    resetAt: state.lastSavedAt,
    previousSessionCount,
    previousProfileCount,
    previousLeadCount,
    previousIdentityCount,
  };
}

Persistence.importJsonLines(LEADS_PATH);
purgeExpiredSessions({ write: false });

module.exports = {
  getSession,
  saveSession,
  resetSession,
  resetConversation,
  resetSystem,
  appendLead,
  listSessions,
  normalizeClientId,
  isSessionExpired,
  purgeExpiredSessions,
  getCustomerProfile,
  rememberCustomerProfile,
  beginCustomerConversation,
  listCustomerProfiles,
  _test: {
    buildCompactLead,
    cleanText,
    cleanOptionalList,
  },
};
