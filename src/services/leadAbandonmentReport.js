'use strict';

const fs = require('fs');
const path = require('path');
const Identity = require('./contactIdentity');
const Inbox = require('./messageInboxStore');
const OutboundLedger = require('./outboundLedgerStore');
const Cursor = require('./conversationCursorStore');
const HumanControl = require('./humanControlStore');
const Store = require('./leadStore');
const Persistence = require('./persistence');
const Operations = require('./leadOperationStore');
const { recoveryConfig } = require('../config/recoveryConfig');
const { leadOperationsConfig } = require('../config/leadOperationsConfig');

const NOTIFICATION_PATH = path.join(process.cwd(), 'data', 'abandoned-lead-notifications.json');
const notificationState = Persistence.readJson(NOTIFICATION_PATH, { records: {}, updatedAt: null });
if (!notificationState.records || typeof notificationState.records !== 'object') notificationState.records = {};

function clean(value, maxLength = 12000) {
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

function cursorAliases(cursor = {}) {
  const aliases = new Set((cursor.aliases || []).map((item) => Identity.normalizeChatId(item)).filter(Boolean));
  if (cursor.primaryChatId) aliases.add(Identity.normalizeChatId(cursor.primaryChatId));
  return aliases;
}

function inboxRecordsForCursor(cursor = {}) {
  const aliases = cursorAliases(cursor);
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

function outboundRecordsForCursor(cursor = {}) {
  const clientId = cursorClientId(cursor);
  const resetAt = timestamp(cursor.resetAt);
  return OutboundLedger.listConversation(clientId, { after: resetAt })
    .sort((a, b) => timestamp(a.sentAt || a.createdAt) - timestamp(b.sentAt || b.createdAt));
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

function outboundText(record = {}) {
  const text = clean(record.text || record.caption, 12000);
  if (text) return text;
  if (record.type === 'image') return `[imagem enviada${record.filename ? `: ${record.filename}` : ''}]`;
  if (/document/.test(record.type || '')) return `[arquivo enviado${record.filename ? `: ${record.filename}` : ''}]`;
  if (record.type === 'list') return '[lista interativa enviada]';
  return `[saída ${record.type || 'desconhecida'}]`;
}

function combinedTranscript(cursor = {}, incoming = [], options = {}) {
  const maxMessages = Math.max(100, Number(options.maxMessages || leadOperationsConfig.transcriptMaxMessages));
  const customer = incoming.map((record) => ({
    at: new Date(recordTimestamp(record)).toISOString(),
    atMs: recordTimestamp(record),
    actor: 'CLIENTE',
    type: record.raw?.type || 'text',
    text: clean(record.text || record.raw?.body || record.raw?.caption, 12000),
    messageId: record.messageId || null,
    status: record.status,
  })).filter((item) => item.text);

  const outgoingAll = outboundRecordsForCursor(cursor);
  const bot = outgoingAll
    .filter((record) => record.status === OutboundLedger.STATUS.SENT)
    .map((record) => ({
      at: record.sentAt || record.createdAt,
      atMs: timestamp(record.sentAt || record.createdAt),
      actor: record.actor || 'BOT',
      type: record.type,
      text: outboundText(record),
      messageId: record.messageId || null,
      status: record.status,
    }));

  const messages = [...customer, ...bot]
    .sort((a, b) => a.atMs - b.atMs || String(a.messageId || '').localeCompare(String(b.messageId || '')))
    .slice(-maxMessages)
    .map(({ atMs, ...item }) => item);

  const warnings = outgoingAll
    .filter((record) => record.status !== OutboundLedger.STATUS.SENT)
    .map((record) => ({
      id: record.id,
      status: record.status,
      at: record.updatedAt || record.createdAt,
      type: record.type,
      summary: outboundText(record),
      error: record.lastError || null,
    }));

  return { messages, warnings, outgoingTotal: outgoingAll.length };
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

function buildLead(cursor, sessions, now) {
  const clientId = cursorClientId(cursor);
  const records = inboxRecordsForCursor(cursor);
  if (!records.length) return null;
  const firstAt = recordTimestamp(records[0]);
  const lastAt = recordTimestamp(records[records.length - 1]);
  const lastAtIso = new Date(lastAt).toISOString();
  const session = sessions.get(cursor.conversationKey) || cursor.session || {};
  const profile = (() => {
    try { return Store.getCustomerProfile(clientId); } catch (_) { return null; }
  })();
  const notification = notificationFor(cursor.conversationKey, lastAtIso);
  const phone = (() => {
    try { return Identity.resolveContact(clientId)?.phone || null; } catch (_) { return null; }
  })();
  const transcript = combinedTranscript(cursor, records);
  const base = {
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
    lastCustomerMessageAt: lastAtIso,
    idleHours: Math.max(0, Math.floor((now - lastAt) / 3600000)),
    firstMessages: firstMessages(records, 3),
    transcript: transcript.messages,
    transcriptWarnings: transcript.warnings,
    transcriptCoverage: 'CLIENT_AND_BOT_FROM_PERSISTENT_LEDGERS',
    outgoingLedgerTotal: transcript.outgoingTotal,
    notifiedAt: notification?.notifiedAt || null,
    sessionExpired: cursor.lifecycle === 'EXPIRED',
  };
  const operation = Operations.ensureLead(base, { source: 'lead_report' });
  const closedBySeller = [Operations.STATUS.CONTACTED, Operations.STATUS.DISCARDED].includes(operation?.status);
  return {
    ...base,
    operationId: operation?.id || null,
    operationStatus: operation?.status || Operations.STATUS.PENDING,
    assignedTo: operation?.assignedTo || null,
    operationNote: operation?.note || null,
    seenAt: operation?.seenAt || null,
    contactedAt: operation?.contactedAt || null,
    discardedAt: operation?.discardedAt || null,
    alertStatus: operation?.alertStatus || 'PENDING',
    alertAttempts: Number(operation?.alertAttempts || 0),
    needsNotification: !notification && !closedBySeller,
    audit: operation?.audit || [],
  };
}

function buildReport(options = {}) {
  const now = Number(options.now || Date.now());
  const thresholdHours = Math.max(1, Number(options.thresholdHours || recoveryConfig.abandonedLeadHours));
  refreshLifecycle({ now, thresholdHours });
  const sessions = sessionMap();
  const leads = [];

  for (const cursor of Cursor.listAll()) {
    if (!['ABANDONED_24H', 'EXPIRED'].includes(cursor.lifecycle)) continue;
    const lead = buildLead(cursor, sessions, now);
    if (lead) leads.push(lead);
  }

  leads.sort((a, b) => timestamp(a.lastCustomerMessageAt) - timestamp(b.lastCustomerMessageAt));
  return {
    generatedAt: new Date(now).toISOString(),
    thresholdHours,
    total: leads.length,
    pendingNotification: leads.filter((lead) => lead.needsNotification).length,
    pendingAction: leads.filter((lead) => [Operations.STATUS.PENDING, Operations.STATUS.SEEN].includes(lead.operationStatus)).length,
    contacted: leads.filter((lead) => lead.operationStatus === Operations.STATUS.CONTACTED).length,
    discarded: leads.filter((lead) => lead.operationStatus === Operations.STATUS.DISCARDED).length,
    leads,
  };
}

function findLead(conversationKey, lastCustomerMessageAt, options = {}) {
  const report = buildReport(options);
  const lead = report.leads.find((item) => (
    item.conversationKey === conversationKey
    && timestamp(item.lastCustomerMessageAt) === timestamp(lastCustomerMessageAt)
  ));
  return lead || null;
}

function formatDate(value) {
  if (!value) return '-';
  try { return new Date(value).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }); } catch (_) { return value; }
}

function leadToTxt(lead = {}, report = {}) {
  const lines = [
    'RELATÓRIO DE LEAD PARADO',
    `Gerado em: ${formatDate(report.generatedAt || new Date().toISOString())}`,
    `Critério: ${report.thresholdHours || recoveryConfig.abandonedLeadHours} hora(s) sem nova mensagem`,
    '',
    `Nome: ${lead.customerName || 'Não identificado'}`,
    `Contato: ${lead.phone || lead.clientId || '-'}`,
    `Serviço: ${lead.service || '-'}`,
    `Cidade: ${lead.city || '-'}`,
    `Etapa: ${lead.stage || '-'}`,
    `Situação do fluxo: ${lead.lifecycle || '-'}`,
    `Situação no painel: ${lead.operationStatus || Operations.STATUS.PENDING}`,
    `Primeiro contato: ${formatDate(lead.firstContactAt)}`,
    `Última mensagem: ${formatDate(lead.lastCustomerMessageAt)}`,
    `Tempo parado: ${Number(lead.idleHours || 0)} hora(s)`,
    '',
    'CONVERSA COMPLETA REGISTRADA',
  ];

  for (const message of lead.transcript || []) {
    const type = message.type && !['text', 'chat'].includes(String(message.type).toLowerCase())
      ? ` (${message.type})`
      : '';
    lines.push(`[${formatDate(message.at)}] ${message.actor}${type}: ${message.text}`);
  }

  if (!(lead.transcript || []).length) lines.push('[Nenhuma mensagem disponível]');
  if ((lead.transcriptWarnings || []).length) {
    lines.push('', 'AVISOS DO LEDGER DE SAÍDA');
    for (const warning of lead.transcriptWarnings) {
      lines.push(`[${formatDate(warning.at)}] ${warning.status}: ${warning.summary}${warning.error ? ` | ${warning.error}` : ''}`);
    }
  }
  lines.push('', 'Cobertura: mensagens do cliente persistidas pela Inbox e respostas do bot persistidas pelo ledger de saída a partir da ativação desta etapa.');
  return `${lines.join('\n').trim()}\n`;
}

function toTxt(report = {}) {
  const lines = [
    'RELATÓRIO DE LEADS PARADOS',
    `Gerado em: ${formatDate(report.generatedAt)}`,
    `Critério: ${report.thresholdHours || 24} hora(s) sem nova mensagem`,
    `Total: ${report.total || 0}`,
    `Aguardando aviso: ${report.pendingNotification || 0}`,
    `Aguardando ação: ${report.pendingAction || 0}`,
    '',
  ];
  for (const [index, lead] of (report.leads || []).entries()) {
    lines.push(`================ LEAD ${index + 1} ================`);
    lines.push(leadToTxt(lead, report).trim());
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

function writeLeadTxt(lead, options = {}) {
  if (!lead) throw new Error('LEAD_REQUIRED');
  const generatedAt = options.generatedAt || new Date().toISOString();
  const dir = path.resolve(process.cwd(), options.outputDir || path.join('data', 'reports', 'leads'));
  fs.mkdirSync(dir, { recursive: true });
  const safe = clean(lead.phone || lead.conversationKey || 'lead', 120).replace(/[^a-zA-Z0-9_-]+/g, '-');
  const stamp = generatedAt.replace(/[:.]/g, '-');
  const filePath = path.join(dir, `lead-${safe}-${stamp}.txt`);
  fs.writeFileSync(filePath, leadToTxt(lead, { generatedAt, thresholdHours: options.thresholdHours }), 'utf8');
  return { filePath, content: fs.readFileSync(filePath, 'utf8') };
}

module.exports = {
  buildReport,
  combinedTranscript,
  findLead,
  firstMessages,
  inboxRecordsForCursor,
  leadToTxt,
  markNotified,
  outboundRecordsForCursor,
  refreshLifecycle,
  toTxt,
  writeLeadTxt,
  writeTxtReport,
  _test: {
    notificationFor,
    recordTimestamp,
    sessionMap,
  },
};
