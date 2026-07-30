'use strict';

const fs = require('node:fs');
const path = require('node:path');
const QrAccess = require('../services/qrAccess');

const STATUS_PATH = path.resolve(process.cwd(), process.env.QR_STATUS_JSON || 'data/qr-status/status.json');
const ACTIVE_QR_TTL_MS = Math.max(30000, Number(process.env.QR_ACTIVE_TTL_MS || 120000));

const TRANSIENT_QR_STATES = new Set([
  'NOTLOGGED',
  'QRREADFAIL',
  'WAITFORLOGIN',
  'PAIRING',
  'OPENING',
  'UNLAUNCHED',
  'BROWSEROPENING',
  'INITIALIZING',
  'STARTING',
  'CHECKING',
]);

const CONNECTED_ALIASES = new Set([
  'ISLOGGED',
]);

const STATE_ALIASES = Object.freeze({
  DESCONECTEDMOBILE: 'DISCONNECTEDMOBILE',
  BROWSERCLOSE: 'DISCONNECTED',
  AUTOCLOSECALLED: 'DISCONNECTED',
  DELETETOKEN: 'UNPAIRED',
});

let lastQrPublishedAt = 0;
let lastPreservedLogAt = 0;

function normalizeState(value) {
  return String(value || '')
    .trim()
    .replace(/[\s_-]+/g, '')
    .toUpperCase();
}

function readSnapshot() {
  try {
    if (!fs.existsSync(STATUS_PATH)) return null;
    return JSON.parse(fs.readFileSync(STATUS_PATH, 'utf8'));
  } catch (_) {
    return null;
  }
}

function hasFreshActiveQr() {
  const snapshot = readSnapshot();
  if (!snapshot || snapshot.status !== 'qr' || !String(snapshot.imageSrc || '').startsWith('data:image')) {
    return false;
  }

  return lastQrPublishedAt > 0 && (Date.now() - lastQrPublishedAt) <= ACTIVE_QR_TTL_MS;
}

if (!QrAccess.__qrStateConsistencyInstalled) {
  const originalPublishQrCode = QrAccess.publishQrCode.bind(QrAccess);
  const originalPublishConnected = QrAccess.publishConnected.bind(QrAccess);
  const originalPublishState = QrAccess.publishState.bind(QrAccess);

  QrAccess.publishQrCode = function publishQrCodeConsistently(payload = {}) {
    lastQrPublishedAt = Date.now();
    return originalPublishQrCode(payload);
  };

  QrAccess.publishConnected = function publishConnectedConsistently(connectionState = 'CONNECTED') {
    lastQrPublishedAt = 0;
    return originalPublishConnected(connectionState);
  };

  QrAccess.publishState = function publishStateConsistently(connectionState, message = '') {
    const normalized = normalizeState(connectionState);
    const mapped = STATE_ALIASES[normalized] || normalized;

    if (CONNECTED_ALIASES.has(mapped)) {
      lastQrPublishedAt = 0;
      return originalPublishConnected(mapped);
    }

    if (TRANSIENT_QR_STATES.has(mapped) && hasFreshActiveQr()) {
      const now = Date.now();
      if ((now - lastPreservedLogAt) >= 15000) {
        lastPreservedLogAt = now;
        console.log(`[QR] estado transitório preservou QR ativo | estado=${mapped}`);
      }
      return undefined;
    }

    if (!TRANSIENT_QR_STATES.has(mapped)) {
      lastQrPublishedAt = 0;
    }

    return originalPublishState(mapped, message);
  };

  QrAccess.__qrStateConsistencyInstalled = true;
}

console.log(`[QR] consistência de estado ativa | ttl=${ACTIVE_QR_TTL_MS}ms`);

module.exports = {
  _test: {
    normalizeState,
    readSnapshot,
  },
};
