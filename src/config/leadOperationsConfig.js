'use strict';

function bool(name, fallback = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === '') return fallback;
  return ['1', 'true', 'yes', 'sim', 'on'].includes(String(raw).trim().toLowerCase());
}

function num(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function list(name) {
  return [...new Set(String(process.env[name] || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean))];
}

const leadOperationsConfig = Object.freeze({
  outboundLedgerEnabled: bool('OUTBOUND_LEDGER_ENABLED', true),
  outboundUncertainAfterMs: Math.max(30000, num('OUTBOUND_LEDGER_UNCERTAIN_AFTER_MS', 300000)),
  outboundTtlDays: Math.max(30, num('OUTBOUND_LEDGER_TTL_DAYS', 180)),
  outboundFailedTtlDays: Math.max(30, num('OUTBOUND_LEDGER_FAILED_TTL_DAYS', 365)),
  outboundMaxEntries: Math.max(5000, num('OUTBOUND_LEDGER_MAX_ENTRIES', 50000)),
  outboundMaxAttempts: Math.max(1, num('OUTBOUND_LEDGER_MAX_ATTEMPTS', 3)),
  transcriptMaxMessages: Math.max(100, num('LEAD_TRANSCRIPT_MAX_MESSAGES', 2000)),
  operationTtlDays: Math.max(90, num('LEAD_OPERATION_TTL_DAYS', 365)),
  alertEnabled: bool('LEAD_ALERT_ENABLED', true),
  alertRecipients: list('LEAD_ALERT_RECIPIENT_CHAT_IDS'),
  alertIntervalMs: Math.max(60000, num('LEAD_ALERT_INTERVAL_MS', 900000)),
  alertMaxPerRun: Math.max(1, num('LEAD_ALERT_MAX_PER_RUN', 20)),
  alertSendTxt: bool('LEAD_ALERT_SEND_TXT', true),
  panelEnabled: bool('LEAD_PANEL_ENABLED', true),
  panelPublicUrl: String(process.env.LEAD_PANEL_PUBLIC_URL || '').trim(),
});

module.exports = { leadOperationsConfig };
