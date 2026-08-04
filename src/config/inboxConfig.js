'use strict';

const { env } = require('./env');

function bool(name, fallback = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === '') return fallback;
  return ['1', 'true', 'yes', 'sim', 'on'].includes(String(raw).trim().toLowerCase());
}

function num(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

const largestBufferMs = Math.max(
  Number(env.bufferMs || 0),
  Number(env.multiMessageBufferMs || 0),
  Number(env.measureBufferMs || 0),
  Number(env.artBufferMs || 0),
  Number(env.addressBufferMs || 0),
  Number(env.pantoneBufferMs || 0),
  Number(env.observationBufferMs || 0),
  Number(env.supportBufferMs || 0),
  Number(env.cityBufferMs || 0),
);

const inboxConfig = Object.freeze({
  enabled: bool('MESSAGE_INBOX_ENABLED', true),
  leaseMs: Math.max(
    30000,
    num('MESSAGE_INBOX_LEASE_MS', Math.max(120000, Number(env.chatProcessTimeoutMs || 45000) * 3)),
  ),
  maxAttempts: Math.max(1, num('MESSAGE_INBOX_MAX_ATTEMPTS', 3)),
  retryBaseMs: Math.max(1000, num('MESSAGE_INBOX_RETRY_BASE_MS', 5000)),
  retryMaxMs: Math.max(10000, num('MESSAGE_INBOX_RETRY_MAX_MS', 900000)),
  retryPollMs: Math.max(5000, num('MESSAGE_INBOX_RETRY_POLL_MS', 15000)),
  recoveryDelayMs: Math.max(500, num('MESSAGE_INBOX_RECOVERY_DELAY_MS', 2500)),
  recoveryBatchSize: Math.max(1, num('MESSAGE_INBOX_RECOVERY_BATCH_SIZE', 50)),
  staleMs: Math.max(
    5000,
    num('MESSAGE_INBOX_STALE_MS', Math.max(30000, largestBufferMs + 10000)),
  ),
  processedTtlDays: Math.max(1, num('MESSAGE_INBOX_PROCESSED_TTL_DAYS', 7)),
  failedTtlDays: Math.max(1, num('MESSAGE_INBOX_FAILED_TTL_DAYS', 30)),
  maxEntries: Math.max(1000, num('MESSAGE_INBOX_MAX_ENTRIES', 20000)),
  maintenanceMs: Math.max(60000, num('MESSAGE_INBOX_MAINTENANCE_MS', 900000)),
});

module.exports = { inboxConfig };
