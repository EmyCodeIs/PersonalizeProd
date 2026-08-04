'use strict';

const crypto = require('crypto');
const path = require('path');
const Persistence = require('./persistence');
const { leadOperationsConfig } = require('../config/leadOperationsConfig');

const FILE_PATH = path.resolve(process.cwd(), 'data', 'lead-operations.json');
const STATUS = Object.freeze({
  PENDING: 'PENDING',
  SEEN: 'SEEN',
  CONTACTED: 'CONTACTED',
  DISCARDED: 'DISCARDED',
});
const ALLOWED = new Set(Object.values(STATUS));

const state = Persistence.readJson(FILE_PATH, { version: 1, records: {}, updatedAt: null });
if (!state.records || typeof state.records !== 'object') state.records = {};

function clean(value, maxLength = 1000) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, maxLength) : '';
}

function nowIso(now = Date.now()) {
  return new Date(Number(now) || Date.now()).toISOString();
}

function timestamp(value) {
  const parsed = new Date(value || 0).getTime();
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function persist() {
  state.updatedAt = nowIso();
  Persistence.writeJson(FILE_PATH, state);
}

function cycleKey(conversationKey, lastCustomerMessageAt) {
  const conversation = clean(conversationKey, 300);
  const lastAt = clean(lastCustomerMessageAt, 80);
  if (!conversation || !lastAt) return null;
  return `lead:${crypto.createHash('sha256').update(`${conversation}|${lastAt}`).digest('hex')}`;
}

function appendAudit(record, action, payload = {}) {
  const audit = Array.isArray(record.audit) ? [...record.audit] : [];
  audit.push({
    action: clean(action, 80),
    fromStatus: clean(payload.fromStatus, 40) || null,
    toStatus: clean(payload.toStatus, 40) || null,
    actor: clean(payload.actor || 'system', 120),
    note: clean(payload.note, 1000) || null,
    source: clean(payload.source || 'runtime', 120),
    at: payload.at || nowIso(),
    metadata: payload.metadata && typeof payload.metadata === 'object' ? payload.metadata : null,
  });
  return audit.slice(-100);
}

function ensureLead(lead = {}, options = {}) {
  const id = cycleKey(lead.conversationKey, lead.lastCustomerMessageAt);
  if (!id) return null;
  const at = nowIso(options.now);
  const existing = state.records[id];
  if (existing) {
    existing.customerName = clean(lead.customerName, 160) || existing.customerName || null;
    existing.clientId = clean(lead.clientId, 260) || existing.clientId || null;
    existing.phone = clean(lead.phone, 80) || existing.phone || null;
    existing.service = clean(lead.service, 100) || existing.service || null;
    existing.stage = clean(lead.stage, 120) || existing.stage || null;
    existing.idleHours = Number(lead.idleHours || 0);
    existing.updatedAt = at;
    state.records[id] = existing;
    persist();
    return { ...existing };
  }

  const record = {
    id,
    conversationKey: clean(lead.conversationKey, 300),
    clientId: clean(lead.clientId, 260) || null,
    phone: clean(lead.phone, 80) || null,
    customerName: clean(lead.customerName, 160) || null,
    service: clean(lead.service, 100) || null,
    stage: clean(lead.stage, 120) || null,
    lastCustomerMessageAt: clean(lead.lastCustomerMessageAt, 80),
    idleHours: Number(lead.idleHours || 0),
    status: STATUS.PENDING,
    seenAt: null,
    contactedAt: null,
    discardedAt: null,
    assignedTo: null,
    note: null,
    alertStatus: 'PENDING',
    alertAttempts: 0,
    lastAlertAt: null,
    alertRecipients: [],
    reportPath: null,
    createdAt: at,
    updatedAt: at,
    audit: [],
  };
  record.audit = appendAudit(record, 'LEAD_CREATED', {
    toStatus: STATUS.PENDING,
    actor: options.actor || 'system',
    source: options.source || 'lead_report',
    at,
  });
  state.records[id] = record;
  persist();
  return { ...record };
}

function getById(id) {
  const key = clean(id, 300);
  return key && state.records[key] ? { ...state.records[key] } : null;
}

function getForLead(conversationKey, lastCustomerMessageAt) {
  const id = cycleKey(conversationKey, lastCustomerMessageAt);
  return id ? getById(id) : null;
}

function updateStatus(payload = {}) {
  const id = clean(payload.id, 300) || cycleKey(payload.conversationKey, payload.lastCustomerMessageAt);
  const record = id ? state.records[id] : null;
  if (!record) {
    const error = new Error('LEAD_OPERATION_NOT_FOUND');
    error.code = 'LEAD_OPERATION_NOT_FOUND';
    throw error;
  }

  const nextStatus = clean(payload.status, 40).toUpperCase();
  if (!ALLOWED.has(nextStatus)) {
    const error = new Error(`LEAD_STATUS_INVALID: ${nextStatus}`);
    error.code = 'LEAD_STATUS_INVALID';
    throw error;
  }

  const at = nowIso(payload.now);
  const previous = record.status;
  record.status = nextStatus;
  record.updatedAt = at;
  record.assignedTo = clean(payload.assignedTo, 120) || record.assignedTo || null;
  if (payload.note !== undefined) record.note = clean(payload.note, 1000) || null;
  if (nextStatus === STATUS.SEEN) record.seenAt = record.seenAt || at;
  if (nextStatus === STATUS.CONTACTED) {
    record.seenAt = record.seenAt || at;
    record.contactedAt = at;
  }
  if (nextStatus === STATUS.DISCARDED) record.discardedAt = at;
  record.audit = appendAudit(record, 'STATUS_CHANGED', {
    fromStatus: previous,
    toStatus: nextStatus,
    actor: payload.actor || 'seller',
    note: payload.note,
    source: payload.source || 'panel',
    at,
  });
  state.records[id] = record;
  persist();
  return { ...record };
}

function recordAlert(payload = {}) {
  const id = clean(payload.id, 300) || cycleKey(payload.conversationKey, payload.lastCustomerMessageAt);
  const record = id ? state.records[id] : null;
  if (!record) return null;
  const at = nowIso(payload.now);
  const status = clean(payload.status || 'SENT', 60).toUpperCase();
  record.alertStatus = status;
  record.alertAttempts = Number(record.alertAttempts || 0) + (payload.countAttempt === false ? 0 : 1);
  record.lastAlertAt = at;
  record.alertRecipients = [...new Set((payload.recipients || []).map((item) => clean(item, 260)).filter(Boolean))];
  record.reportPath = clean(payload.reportPath, 1000) || record.reportPath || null;
  record.updatedAt = at;
  record.audit = appendAudit(record, `ALERT_${status}`, {
    actor: payload.actor || 'system',
    source: payload.source || 'lead_alert',
    note: payload.note,
    at,
    metadata: { recipients: record.alertRecipients, reportPath: record.reportPath },
  });
  state.records[id] = record;
  persist();
  return { ...record };
}

function listAll(options = {}) {
  const status = clean(options.status, 40).toUpperCase();
  return Object.values(state.records)
    .filter((record) => !status || record.status === status)
    .map((record) => ({ ...record }))
    .sort((a, b) => timestamp(b.updatedAt) - timestamp(a.updatedAt));
}

function stats() {
  const output = { total: 0 };
  for (const record of Object.values(state.records)) {
    output.total += 1;
    output[record.status] = Number(output[record.status] || 0) + 1;
    output[`ALERT_${record.alertStatus || 'UNKNOWN'}`] = Number(output[`ALERT_${record.alertStatus || 'UNKNOWN'}`] || 0) + 1;
  }
  return output;
}

function purge(options = {}) {
  const now = Number(options.now || Date.now());
  const ttlMs = Math.max(90, Number(options.ttlDays || leadOperationsConfig.operationTtlDays)) * 86400000;
  let removed = 0;
  for (const [id, record] of Object.entries(state.records)) {
    if ((now - timestamp(record.updatedAt || record.createdAt)) <= ttlMs) continue;
    delete state.records[id];
    removed += 1;
  }
  if (removed) persist();
  return removed;
}

module.exports = {
  STATUS,
  cycleKey,
  ensureLead,
  getById,
  getForLead,
  listAll,
  purge,
  recordAlert,
  stats,
  updateStatus,
  _test: { appendAudit, clean, timestamp },
};
