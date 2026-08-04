'use strict';

const fs = require('fs');
const path = require('path');
const Identity = require('./contactIdentity');
const Inbox = require('./messageInboxStore');
const Cursor = require('./conversationCursorStore');
const HumanControl = require('./humanControlStore');
const Store = require('./leadStore');
const Persistence = require('./persistence');
const { recoveryConfig } = require('../config/recoveryConfig');

const NOTIFICATION_PATH = path.join(process.cwd(), 'data', 'abandoned-lead-notifications.json');
const notificationState = Persistence.readJson(NOTIFICATION_PATH, { records: {}, updatedAt: null });
if (!notificationState.records || typeof notificationState.records !== 'object') notificationState.records = {};

function clean(value, maxLength = 4000) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, maxLength) : '';
}

function timestamp(value) {
  const parsed = new Date(value || 0).getTime();
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function recordTimestamp(record = {}) {
  const raw = record.raw || {};
  for (const candidate of [record.sourceTimestamp, raw.timestamp, raw.t, raw.messageTimestamp]) {
    const numeric = Number(candidate);
    if (!Number.isFinite(numeric) || numeric <= 0) continue;
    return numeric < 1000000000000 ? numeric * 1000 : numeric;
  }
  return timestamp(record.receivedAt || record.updatedAt);
}

function persistNotifications() {
  notificationState.updatedAt = new Date().toISOString();
  Persistence.writeJson(NOTIFICATION_PATH, notificationState);
}

function sessionMap() {
  const map = new Map();
  for (const session of Store.listSessions()) {
    const clientId = session.chatId || session.clientId || session.id;
    if (!clientId) continue;
    map.set(Store.normalizeClientId(clientId), session);
  }
  return map;
}

function cursorClientId(cursor = {}) {
  return cursor.primaryChatId || cursor.aliases?.[0] || cursor.conversationKey || '';
}

function inboxRecordsForCursor(cursor = {}) {
  const aliases = new Set((cursor.aliases || []).map((item) => Identity.normalizeChatId(item)).filter(Boolean));
  if (cursor.primaryChatId) aliases.add(Identity.normalizeChatId(cursor.primaryChatId));
  const key = cursor.conversationKey;
  return Inbox.listAll()
    .filter((record) => record.status !== Inbox.STATUS.RESET)
    .filter((record) => {
      const id = record.conversationId || record.from;
      if (aliases.has(Identity.normalizeChatId(id))) return true;
      try { return Identity.getSessionKey(id) === key; } catch (_) { return false; }
    })
    .filter((record) => {
      const resetAt = timestamp(cursor.resetAt);
      return !resetAt || recordTimestamp(record) > resetAt;
    })
    .sort((a, b) => recordTimestamp(a) - recordTimestamp(b));
}

function firstMessages(records = [], limit = 3) {
  return records
    .filter((record) => clean(record.text || record.raw?.body || record.raw?.caption, 4000))
    .slice(0, Math.max(1, Number(limit || 3)))
    .map((record) => ({
      at: new Date(recordTimestamp(record)).toISOString(),
      text: clean(record.text || record.raw?.body || record.raw?.caption, 1000),
    }));
}

function latestMessages(records = [], limit = recoveryConfig.reportMessageLimit) {
  return records
    .filter((record) => clean(record.text || record.raw?.body || record.raw?.caption, 4000))
    .slice(-Math.max(1, Number(limit || 20)))
    .map((record) => ({
      at: new Date(recordTimestamp(record)).toISOString(),
      actor: 'CLIENTE',
      text: clean(record.text || record.raw?.body || record.raw?.caption, 2000),
      messageId: record.messageId || null,
    }));
}

function notificationFor(key, lastCustomerMessageAt) {
  const record = notificationState.records[key];
  if (!record) return null;
  if (timestamp(record.lastCustomerMessageAt) !== timestamp(lastCustomerMessageAt)) return null;
  return { ...record };
}

function markNotified(conversationKey, payload = {}) {
  const key = clean(conversationKey, 240);
  if (!key) return null;
  const record = {
    conversationKey: key,
    notifiedAt: payload.notifiedAt || new Date().toISOString(),
    lastCustomerMessageAt: payload.lastCustomerMessageAt || null,
    channel: clean(payload.channel || 'system', 80),
    reportId: clean(payload.reportId, 160) || null,
  };
  notificationState.records[key] = record;
  persistNotifications();
  return { ...record };
}

function refreshLifecycle(options = {}) {
  const now = Number(options.now || Date.now());
  const thresholdHours = Math.max(1, Number(options.thresholdHours || recoveryConfig.abandonedLeadHours));
  const thresholdMs = thresholdHours * 3600000;
  const sessions = sessionMap();
  const summary = { active: 0, abandoned: 0, expired: 0, completed: 0, handoff: 0, reset: 0 };

  for (const cursor of Cursor.listAll()) {
    const clientId = cursorClientId(cursor);
    const session = sessions.get(cursor.conversationKey) || null;
    const snapshot = session || cursor.session || null;
    const block = clientId ? HumanControl.getBlock(clientId) : null;
    const records = inboxRecordsForCursor(cursor);
    const lastCustomerAt = records.length
      ? recordTimestamp(records[records.length - 1])
      : timestamp(cursor.lastCustomerMessageAt || snapshot?.lastInteractionAt || snapshot?.updatedAt);
    let lifecycle = 'ACTIVE';
    let reason = 'conversation_active';

    if (cursor.lifecycle === 'RESET' && !cursor.lastProcessedAt) {
      lifecycle = 'RESET';
      reason = 'conversation_reset';
    } else if (snapshot?.completed) {
      lifecycle = 'COMPLETED';
      reason = 'flow_completed';
    } else if (block?.blocked) {
      lifecycle = 'HANDOFF';
      reason = block.control?.reason || 'human_block';
    } else if (lastCustomerAt && (now - lastCustomerAt) >= thresholdMs) {
      const expiresAt = timestamp(snapshot?.expiresAt);
      lifecycle = !session && expiresAt && expiresAt <= now ? 'EXPIRED' : 'ABANDONED_24H';
      reason = lifecycle === 'EXPIRED' ? 'session_expired_without_completion' : 'customer_inactive_24h';
    }

    Cursor.markLifecycle(clientId || cursor.conversationKey, lifecycle, { reason, session: snapshot, now });
    if (lifecycle === 'ACTIVE') summary.active += 1;
    else if (lifecycle === 'ABANDONED_24H') summary.abandoned += 1;
    else if (lifecycle === 'EXPIRED') summary.expired += 1;
    else if (lifecycle === 'COMPLETED') summary.completed += 1;
    else if (lifecycle === 'HANDOFF') summary.handoff += 1;
    else if (lifecycle === 'RESET') summary.reset += 1;
  }
  return summary;
}

function buildReport(options = {}) {
  const now = Number(options.now || Date.now());
  const thresholdHours = Math.max(1, Number(options.thresholdHours || recoveryConfig.abandonedLeadHours));
  refreshLifecycle({ now, thresholdHours });
  const sessions = sessionMap();
  const leads = [];

  for (const cursor of Cursor.listAll()) {
    if (!['ABANDONED_24H', 'EXPIRED'].includes(cursor.lifecycle)) continue;
    const clientId = cursorClientId(cursor);
    const records = inboxRecordsForCursor(cursor);
    if (!records.length) continue;
    const firstAt = recordTimestamp(records[0]);
    const lastAt = recordTimestamp(records[records.length - 1]);
    const session = sessions.get(cursor.conversationKey) || cursor.session || {};
    const profile = (() => {
      try { return Store.getCustomerProfile(clientId); } catch (_) { return null; }
    })();
    const notification = notificationFor(cursor.conversationKey, new Date(lastAt).toISOString());
    const phone = (() => {
      try { return Identity.resolveContact(clientId)?.phone || null; } catch (_) { return null; }
    })();
    leads.push({
      id: `pending:${cursor.conversationKey}`,
      conversationKey: cursor.conversationKey,
      clientId,
      phone,
      customerName: session?.customerName || session?.dados?.nome || profile?.knownName || null,
      service: session?.service || session?.dados?.flow || null,
      city: session?.city || session?.dados?.cidade || null,
      stage: session?.etapa || 'desconhecida',
      lifecycle: cursor.lifecycle,
      lifecycleReason: cursor.lifecycleReason || null,
      firstContactAt: new Date(firstAt).toISOString(),
      lastCustomerMessageAt: new Date(lastAt).toISOString(),
      idleHours: Math.max(0, Math.floor((now - lastAt) / 3600000)),
      firstMessages: firstMessages(records, 3),
      transcript: latestMessages(records),
      transcriptCoverage: 'CLIENT_MESSAGES_ONLY_UNTIL_OUTBOUND_LEDGER',
      notifiedAt: notification?.notifiedAt || null,
      needsNotification: !notification,
      sessionExpired: cursor.lifecycle === 'EXPIRED',
    });
  }

  leads.sort((a, b) => timestamp(a.lastCustomerMessageAt) - timestamp(b.lastCustomerMessageAt));
  return {
    generatedAt: new Date(now).toISOString(),
    thresholdHours,
    total: leads.length,
    pendingNotification: leads.filter((lead) => lead.needsNotification).length,
    leads,
  };
}

function formatDate(value) {
  if (!value) return '-';
  try { return new Date(value).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }); } catch (_) { return value; }
}

function toTxt(report = {}) {
  const lines = [
    'RELATÓRIO DE LEADS PARADOS',
    `Gerado em: ${formatDate(report.generatedAt)}`,
    `Critério: ${report.thresholdHours || 24} hora(s) sem nova mensagem`,
    `Total: ${report.total || 0}`,
    `Aguardando aviso: ${report.pendingNotification || 0}`,
    '',
  ];

  for (const [index, lead] of (report.leads || []).entries()) {
    lines.push(`LEAD ${index + 1}`);
    lines.push(`Nome: ${lead.customerName || 'Não identificado'}`);
    lines.push(`Contato: ${lead.phone || lead.clientId || '-'}`);
    lines.push(`Serviço: ${lead.service || '-'}`);
    lines.push(`Cidade: ${lead.city || '-'}`);
    lines.push(`Etapa: ${lead.stage || '-'}`);
    lines.push(`Situação: ${lead.lifecycle}`);
    lines.push(`Primeiro contato: ${formatDate(lead.firstContactAt)}`);
    lines.push(`Última mensagem: ${formatDate(lead.lastCustomerMessageAt)}`);
    lines.push(`Tempo parado: ${lead.idleHours} hora(s)`);
    lines.push('Primeiras mensagens:');
    for (const message of lead.firstMessages || []) {
      lines.push(`  [${formatDate(message.at)}] ${message.text}`);
    }
    lines.push('Conversa registrada:');
    for (const message of lead.transcript || []) {
      lines.push(`  [${formatDate(message.at)}] ${message.actor}: ${message.text}`);
    }
    lines.push('Observação: nesta etapa o TXT contém as mensagens do cliente; as respostas do bot entram quando o ledger persistente de saída for implementado.');
    lines.push('');
  }
  return `${lines.join('\n').trim()}\n`;
}

function writeTxtReport(options = {}) {
  const report = buildReport(options);
  const dir = path.resolve(process.cwd(), options.outputDir || path.join('data', 'reports'));
  fs.mkdirSync(dir, { recursive: true });
  const stamp = report.generatedAt.replace(/[:.]/g, '-');
  const filePath = path.join(dir, `leads-parados-${stamp}.txt`);
  fs.writeFileSync(filePath, toTxt(report), 'utf8');
  return { report, filePath };
}

module.exports = {
  buildReport,
  firstMessages,
  inboxRecordsForCursor,
  latestMessages,
  markNotified,
  refreshLifecycle,
  toTxt,
  writeTxtReport,
  _test: {
    notificationFor,
    recordTimestamp,
    sessionMap,
  },
};
