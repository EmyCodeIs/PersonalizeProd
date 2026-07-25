'use strict';

const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');

const storage = new AsyncLocalStorage();
const VALID_CATEGORIES = new Set([
  'SISTEMA',
  'ENTRADA',
  'IDENTIDADE',
  'RECUPERAÇÃO',
  'HANDOFF',
  'BUFFER',
  'FILA',
  'FLUXO',
  'ENVIO',
  'ETIQUETA',
  'NOTA',
  'ADMIN',
  'CONEXÃO',
  'ERRO',
]);

const FIELD_ORDER = [
  'evento', 'chat', 'msg', 'etapa', 'origem', 'status', 'motivo',
  'de', 'para', 'tipo', 'ação', 'posição', 'espera', 'duração',
  'quantidade', 'envios', 'confirmado', 'resultado', 'texto', 'erro',
];

function shortId(value, length = 6) {
  const raw = String(value || '').trim();
  if (!raw) return '-';
  return crypto.createHash('sha1').update(raw).digest('hex').slice(0, length).toUpperCase();
}

function rawMessageId(raw = {}) {
  return String(
    raw?.id?._serialized
    || raw?.id
    || raw?.messageId
    || raw?.key?.id
    || '',
  ).trim();
}

function textPreview(value, maxLength = 120) {
  const normalized = String(value || '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return '';
  return normalized.length > maxLength
    ? `${normalized.slice(0, Math.max(1, maxLength - 1))}…`
    : normalized;
}

function messageContext({ raw, chatId, source, text, stage } = {}) {
  const rawId = rawMessageId(raw);
  const fallback = `${chatId || 'unknown'}:${text || ''}:${raw?.timestamp || raw?.t || ''}`;
  return {
    chat: String(chatId || '').trim() || '-',
    msg: shortId(rawId || fallback),
    etapa: String(stage || '').trim() || '-',
    origem: String(source || '').trim() || '-',
  };
}

function currentContext() {
  return storage.getStore() || {};
}

function withDecisionContext(context, action) {
  if (typeof action !== 'function') return null;
  const parent = currentContext();
  const next = {
    ...parent,
    ...(context || {}),
    metrics: {
      ...(parent.metrics || {}),
      ...((context || {}).metrics || {}),
    },
  };
  return storage.run(next, action);
}

function incrementMetric(name, amount = 1) {
  const context = currentContext();
  if (!context.metrics) context.metrics = {};
  context.metrics[name] = Number(context.metrics[name] || 0) + Number(amount || 0);
  return context.metrics[name];
}

function metric(name) {
  return Number(currentContext()?.metrics?.[name] || 0);
}

function normalizeValue(key, value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'boolean') return value ? 'sim' : 'não';
  if (value instanceof Error) return textPreview(value.message || value.name || 'erro');
  if (typeof value === 'object') {
    try { return textPreview(JSON.stringify(value)); } catch (_) { return textPreview(String(value)); }
  }
  const text = textPreview(value, key === 'texto' ? 120 : 180);
  if (!text) return null;
  return key === 'texto' ? `"${text.replace(/"/g, '\\"')}"` : text;
}

function orderedEntries(fields) {
  const entries = Object.entries(fields || {}).filter(([, value]) => value !== undefined);
  const weight = new Map(FIELD_ORDER.map((key, index) => [key, index]));
  return entries.sort(([a], [b]) => {
    const left = weight.has(a) ? weight.get(a) : FIELD_ORDER.length;
    const right = weight.has(b) ? weight.get(b) : FIELD_ORDER.length;
    return left - right || a.localeCompare(b, 'pt-BR');
  });
}

function decision(category, event, fields = {}, level = 'log') {
  const normalizedCategory = String(category || '').trim().toUpperCase();
  const safeCategory = VALID_CATEGORIES.has(normalizedCategory) ? normalizedCategory : 'SISTEMA';
  const context = currentContext();
  const merged = {
    ...context,
    metrics: undefined,
    ...fields,
    evento: event || fields?.evento || undefined,
  };

  const body = orderedEntries(merged)
    .map(([key, value]) => {
      const normalized = normalizeValue(key, value);
      return normalized === null ? null : `${key}=${normalized}`;
    })
    .filter(Boolean)
    .join(' · ');

  const method = ['warn', 'error', 'info'].includes(level) ? level : 'log';
  console[method](`${safeCategory}${body ? ` · ${body}` : ''}`);
}

function decisionError(event, error, fields = {}) {
  decision('ERRO', event, {
    ...fields,
    erro: error?.code || error?.message || error || 'erro_desconhecido',
  }, 'error');
}

module.exports = {
  VALID_CATEGORIES,
  currentContext,
  decision,
  decisionError,
  incrementMetric,
  messageContext,
  metric,
  rawMessageId,
  shortId,
  textPreview,
  withDecisionContext,
};
