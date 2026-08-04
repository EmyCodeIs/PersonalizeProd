'use strict';

function bool(name, fallback = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === '') return fallback;
  return ['1', 'true', 'yes', 'sim', 'on'].includes(String(raw).trim().toLowerCase());
}

function num(name, fallback, minimum = 0) {
  const value = Number(process.env[name]);
  const resolved = Number.isFinite(value) ? value : fallback;
  return Math.max(minimum, resolved);
}

const connectionConfig = Object.freeze({
  enabled: bool('CONNECTION_SUPERVISOR_ENABLED', true),
  deviceSyncTimeoutMs: num('WPP_DEVICE_SYNC_TIMEOUT_MS', 180000, 30000),
  syncTimeoutMs: num('CONNECTION_SYNC_TIMEOUT_MS', 195000, 30000),
  probeTimeoutMs: num('CONNECTION_PROBE_TIMEOUT_MS', 10000, 1000),
  recoveryActionTimeoutMs: num('CONNECTION_RECOVERY_ACTION_TIMEOUT_MS', 15000, 1000),
  recoveryDelayMs: num('CONNECTION_RECOVERY_DELAY_MS', 5000, 250),
  recoveryCooldownMs: num('CONNECTION_RECOVERY_COOLDOWN_MS', 15000, 1000),
  maxRecoveryAttempts: Math.max(1, Math.floor(num('CONNECTION_MAX_RECOVERY_ATTEMPTS', 3, 1))),
  exitOnFailure: bool('CONNECTION_EXIT_ON_FAILURE', true),
  exitDelayMs: num('CONNECTION_EXIT_DELAY_MS', 2500, 250),
  waitForReadyBeforeChannelReturn: bool('WPP_WAIT_FOR_READY_BEFORE_CHANNEL_RETURN', true),
  readyWaitTimeoutMs: num('WPP_READY_WAIT_TIMEOUT_MS', 0, 0),
  deferRetryMs: num('CONNECTION_DEFER_RETRY_MS', 3000, 500),
  detailToken: String(process.env.QR_ADMIN_DETAIL_TOKEN || '').trim(),
});

module.exports = { connectionConfig };
