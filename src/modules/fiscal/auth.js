'use strict';

const crypto = require('node:crypto');

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, expectedHex] = String(stored || '').split(':');
  if (!salt || !expectedHex) return false;
  const actual = crypto.scryptSync(String(password), salt, 64);
  const expected = Buffer.from(expectedHex, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

function sessionDigest(token, secret) {
  return crypto.createHmac('sha256', secret).update(String(token)).digest('hex');
}

function parseCookies(header = '') {
  return Object.fromEntries(String(header).split(';').map((part) => part.trim()).filter(Boolean).map((part) => {
    const index = part.indexOf('=');
    if (index < 0) return [part, ''];
    return [decodeURIComponent(part.slice(0, index)), decodeURIComponent(part.slice(index + 1))];
  }));
}

module.exports = { hashPassword, verifyPassword, randomToken, sessionDigest, parseCookies };
