'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const envPath = path.join(root, '.env');
const templatePath = path.join(root, 'deploy', '.env.vps.ready.example');
const domain = String(process.argv[2] || process.env.SESSION_ACCESS_DOMAIN || '').trim().toLowerCase();

if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain)) {
  console.error('Uso: node scripts/prepare-vps-env.js whatsapp.seudominio.com.br');
  process.exit(1);
}

function parseCurrent(content) {
  const values = new Map();
  for (const line of String(content || '').split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match) values.set(match[1], match[2]);
  }
  return values;
}

function setLine(content, key, value) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${escaped}=.*$`, 'm');
  if (pattern.test(content)) return content.replace(pattern, line);
  return `${content.replace(/\s*$/, '')}\n${line}\n`;
}

const template = fs.readFileSync(templatePath, 'utf8').replaceAll('__DOMAIN__', domain);
const existing = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
let output = existing.trim() ? existing : template;
let current = parseCurrent(output);

const encryptionKey = current.get('DATA_ENCRYPTION_KEY');
if (!encryptionKey || encryptionKey.includes('__GENERATED_')) {
  output = setLine(output, 'DATA_ENCRYPTION_KEY', crypto.randomBytes(32).toString('base64'));
}

const backupPassphrase = current.get('VPS_BACKUP_PASSPHRASE');
if (!backupPassphrase || backupPassphrase.includes('__GENERATED_')) {
  output = setLine(output, 'VPS_BACKUP_PASSPHRASE', crypto.randomBytes(32).toString('base64url'));
}

current = parseCurrent(output);
const adminToken = current.get('QR_ADMIN_DETAIL_TOKEN');
if (!adminToken || adminToken.includes('__GENERATED_')) {
  output = setLine(output, 'QR_ADMIN_DETAIL_TOKEN', crypto.randomBytes(32).toString('base64url'));
}

const required = {
  NODE_ENV: 'production',
  STORAGE_DRIVER: 'sqlite',
  SQLITE_DATABASE_PATH: 'data/personalize.sqlite',
  MOCK_MODE: 'false',
  WPP_HEADLESS: 'false',
  SESSION_ACCESS_HOST: '127.0.0.1',
  SESSION_ACCESS_ALLOW_PUBLIC_BIND: 'false',
  SESSION_ACCESS_PUBLIC_URL: `https://${domain}/vnc.html?autoconnect=true&resize=scale`,
  SESSION_ACCESS_HTTP_USER: 'personalize',
  SESSION_ACCESS_HTTP_PASSWORD: '2580',
  SESSION_ACCESS_PASSWORD: '2580',
  ALLOW_WEAK_SESSION_PASSWORD: 'true',
  BROWSER_CACHE_DIR: 'data/browser-cache',
  BROWSER_DISK_CACHE_MB: '100',
  BROWSER_MEDIA_CACHE_MB: '50',
  BROWSER_CACHE_MAX_MB: '200',
  BROWSER_CACHE_MAX_AGE_DAYS: '3',
  BROWSER_CACHE_AUTO_CLEAN: 'true',
  TOKEN_CACHE_AUTO_CLEAN: 'true',
  QR_ADMIN_HOST: '127.0.0.1',
  QR_ADMIN_PORT: '3210',
  WPP_REQUIRE_SYSTEM_BROWSER: 'true',
  CONNECTION_SUPERVISOR_ENABLED: 'true',
  WPP_CREATE_TIMEOUT_MS: '120000',
  WPP_DEVICE_SYNC_TIMEOUT_MS: '180000',
  CONNECTION_SYNC_TIMEOUT_MS: '195000',
  CONNECTION_PROBE_TIMEOUT_MS: '10000',
  CONNECTION_RECOVERY_ACTION_TIMEOUT_MS: '15000',
  CONNECTION_RECOVERY_DELAY_MS: '5000',
  CONNECTION_RECOVERY_COOLDOWN_MS: '15000',
  CONNECTION_MAX_RECOVERY_ATTEMPTS: '3',
  CONNECTION_EXIT_ON_FAILURE: 'true',
  CONNECTION_EXIT_DELAY_MS: '2500',
  WPP_WAIT_FOR_READY_BEFORE_CHANNEL_RETURN: 'true',
  WPP_READY_WAIT_TIMEOUT_MS: '0',
  MESSAGE_INBOX_ENABLED: 'true',
  CONVERSATION_CURSOR_ENABLED: 'true',
  OUTBOUND_LEDGER_ENABLED: 'true',
  OUTBOUND_LEDGER_UNCERTAIN_AFTER_MS: '300000',
  OUTBOUND_LEDGER_TTL_DAYS: '180',
  OUTBOUND_LEDGER_FAILED_TTL_DAYS: '365',
  OUTBOUND_LEDGER_MAX_ENTRIES: '50000',
  OUTBOUND_LEDGER_MAX_ATTEMPTS: '3',
  LEAD_TRANSCRIPT_MAX_MESSAGES: '2000',
  LEAD_OPERATION_TTL_DAYS: '365',
  LEAD_PANEL_ENABLED: 'true',
  LEAD_PANEL_PUBLIC_URL: `https://${domain}/leads`,
  LEAD_ALERT_ENABLED: 'true',
  LEAD_ALERT_INTERVAL_MS: '900000',
  LEAD_ALERT_MAX_PER_RUN: '20',
  LEAD_ALERT_SEND_TXT: 'true',
};
for (const [key, value] of Object.entries(required)) output = setLine(output, key, value);

if (!parseCurrent(output).has('LEAD_ALERT_RECIPIENT_CHAT_IDS')) {
  output = setLine(output, 'LEAD_ALERT_RECIPIENT_CHAT_IDS', '');
}

fs.writeFileSync(envPath, `${output.trim()}\n`, { encoding: 'utf8', mode: 0o600 });
try { fs.chmodSync(envPath, 0o600); } catch (_) {}

console.log(`[VPS] .env preparado para: https://${domain}/vnc.html?autoconnect=true&resize=scale`);
console.log(`[VPS] painel de leads preparado em: https://${domain}/leads`);
console.log('[VPS] usuário do link: personalize');
console.log('[VPS] senha solicitada: 2580 (fraca; troca recomendada depois)');
console.log('[VPS] chave de banco, senha de backup e token administrativo gerados sem exibição no terminal.');
console.log('[VPS] aviso por WhatsApp permanece inativo até preencher LEAD_ALERT_RECIPIENT_CHAT_IDS.');
