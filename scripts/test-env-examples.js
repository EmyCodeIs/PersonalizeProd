'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

for (const filename of ['.env.vps.example', '.env.vps.ready.example']) {
  const filePath = path.join(__dirname, '..', 'deploy', filename);
  const parsed = dotenv.parse(fs.readFileSync(filePath));
  const rules = String(parsed.SELLER_LABEL_RULES || '');

  for (const expected of [
    'Adriano=#8FD0A8',
    'Ana=#00A4F2',
    'Emy=#7FE51F',
    'C. Eduardo=#FEB100',
  ]) {
    assert.ok(rules.includes(expected), `regra ausente ou cortada em ${filename}: ${expected}`);
  }

  assert.equal(parsed.ENABLE_TEST_COMMANDS, 'false');
  assert.equal(parsed.ENABLE_UNREAD_BOOTSTRAP, 'false');
  assert.equal(parsed.LABEL_MAINTENANCE_AUTO_REMOVE_DUPLICATES, 'false');
  assert.equal(parsed.SESSION_ACCESS_HOST, '127.0.0.1');
  assert.equal(parsed.STORAGE_DRIVER, 'sqlite');
  assert.equal(parsed.SQLITE_DATABASE_PATH, 'data/personalize.sqlite');
  assert.equal(parsed.SESSION_ACCESS_HTTP_USER, 'personalize');
  assert.equal(parsed.SESSION_ACCESS_HTTP_PASSWORD, '2580');
  assert.equal(parsed.SESSION_ACCESS_PASSWORD, '2580');
  assert.equal(parsed.ALLOW_WEAK_SESSION_PASSWORD, 'true');
  assert.equal(parsed.BROWSER_CACHE_DIR, 'data/browser-cache');
  assert.equal(parsed.TOKEN_CACHE_AUTO_CLEAN, 'true');
  assert.equal(parsed.OUTBOUND_LEDGER_ENABLED, 'true');
  assert.equal(parsed.OUTBOUND_LEDGER_UNCERTAIN_AFTER_MS, '300000');
  assert.equal(parsed.LEAD_PANEL_ENABLED, 'true');
  assert.equal(parsed.LEAD_ALERT_ENABLED, 'true');
  assert.equal(parsed.LEAD_ALERT_RECIPIENT_CHAT_IDS, '');
  assert.equal(parsed.LEAD_ALERT_SEND_TXT, 'true');
  assert.equal(parsed.QR_ADMIN_DETAIL_TOKEN, '__GENERATED_ADMIN_TOKEN__');
  assert.match(parsed.LEAD_PANEL_PUBLIC_URL, /^https:\/\/__DOMAIN__\/leads$/);
  assert.match(parsed.SESSION_ACCESS_PUBLIC_URL, /^https:\/\/__DOMAIN__\//);
}

console.log('✅ Ambiente VPS verificado: SQLite, noVNC, ledger, painel protegido, alertas seguros e cache fora de tokens.');
