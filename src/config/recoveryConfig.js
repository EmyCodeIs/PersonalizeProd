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

const recoveryConfig = Object.freeze({
  enabled: bool('CONVERSATION_CURSOR_ENABLED', true),
  maxAgeHours: Math.max(1, num('CONVERSATION_RECOVERY_MAX_AGE_HOURS', env.unreadBootstrapMaxAgeHours || 24)),
  historyLimit: Math.max(20, num('CONVERSATION_RECOVERY_HISTORY_LIMIT', env.unreadRecoveryHistoryLimit || 120)),
  maxChats: Math.max(1, num('CONVERSATION_RECOVERY_MAX_CHATS', env.unreadBootstrapMaxChats || 30)),
  maxRounds: Math.max(1, num('CONVERSATION_RECOVERY_MAX_ROUNDS', 20)),
  baselineGraceMs: Math.max(0, num('CONVERSATION_RECOVERY_BASELINE_GRACE_MS', 1500)),
  cursorTtlDays: Math.max(30, num('CONVERSATION_CURSOR_TTL_DAYS', 180)),
  lifecycleRefreshMs: Math.max(60000, num('LEAD_LIFECYCLE_REFRESH_MS', 900000)),
  abandonedLeadHours: Math.max(1, num('ABANDONED_LEAD_HOURS', 24)),
  reportMessageLimit: Math.max(1, num('ABANDONED_LEAD_REPORT_MESSAGE_LIMIT', 20)),
});

module.exports = { recoveryConfig };
