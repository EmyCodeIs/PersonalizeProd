'use strict';

const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');

const storage = new AsyncLocalStorage();

function clean(value, maxLength = 4000) {
  const text = String(value ?? '').trim();
  return text ? text.slice(0, maxLength) : '';
}

function unique(values = []) {
  return [...new Set(values.map((item) => clean(item, 260)).filter(Boolean))].sort();
}

function contentHash(payload = {}) {
  const source = [
    clean(payload.type, 80),
    clean(payload.text, 12000),
    clean(payload.caption, 12000),
    clean(payload.filename, 500),
  ].join('|');
  return crypto.createHash('sha256').update(source).digest('hex').slice(0, 24);
}

function current() {
  return storage.getStore() || null;
}

function runForInboundBatch(payload = {}, action) {
  if (typeof action !== 'function') return null;
  const context = {
    conversationId: clean(payload.conversationId, 240),
    inboxIds: unique(payload.inboxIds || []),
    source: clean(payload.source || 'customer_flow', 120),
    sequence: 0,
    suppressClientLedger: false,
  };
  return storage.run(context, action);
}

function runSuppressClientLedger(action) {
  if (typeof action !== 'function') return null;
  const active = current();
  const context = active
    ? { ...active, suppressClientLedger: true }
    : { conversationId: '', inboxIds: [], source: 'direct', sequence: 0, suppressClientLedger: true };
  return storage.run(context, action);
}

function clientLedgerSuppressed() {
  return current()?.suppressClientLedger === true;
}

function nextOperation(payload = {}) {
  const active = current();
  const explicit = clean(payload.operationKey, 500);
  if (explicit) {
    return {
      operationKey: explicit,
      sequence: Number(payload.sequence || 0),
      inboxIds: unique(payload.inboxIds || active?.inboxIds || []),
      source: clean(payload.source || active?.source || 'explicit', 120),
    };
  }

  if (!active?.inboxIds?.length) {
    return {
      operationKey: null,
      sequence: 0,
      inboxIds: [],
      source: clean(payload.source || active?.source || 'unscoped', 120),
    };
  }

  active.sequence = Number(active.sequence || 0) + 1;
  const sequence = active.sequence;
  const hash = contentHash(payload);
  return {
    operationKey: `flow:${active.inboxIds.join(',')}:${sequence}:${clean(payload.type || 'text', 40)}:${hash}`,
    sequence,
    inboxIds: [...active.inboxIds],
    source: clean(payload.source || active.source || 'customer_flow', 120),
  };
}

module.exports = {
  clientLedgerSuppressed,
  contentHash,
  current,
  nextOperation,
  runForInboundBatch,
  runSuppressClientLedger,
  unique,
};
