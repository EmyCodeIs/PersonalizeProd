'use strict';

const assert = require('assert');
const {
  isTesterIdentity,
  isTestCommandAuthorized,
} = require('../src/core/testCommandAccess');

const KEYS = [
  'TEST_COMMAND_ALLOWED_CLIENT_NUMBERS',
  'TEST_COMMAND_ALLOWED_CHAT_IDS',
  'TEST_COMMAND_LID_NUMBER_MAP',
  'ALLOWED_CLIENT_NUMBERS',
  'ALLOWED_CHAT_IDS',
  'LID_NUMBER_MAP',
];
const previous = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));

function restore() {
  for (const key of KEYS) {
    if (previous[key] === undefined) delete process.env[key];
    else process.env[key] = previous[key];
  }
}

try {
  process.env.TEST_COMMAND_ALLOWED_CLIENT_NUMBERS = '31971386091';
  process.env.TEST_COMMAND_ALLOWED_CHAT_IDS = '18885055098907@lid';
  process.env.TEST_COMMAND_LID_NUMBER_MAP = '18885055098907@lid=31971386091';
  process.env.LID_NUMBER_MAP = '';

  assert.strictEqual(
    isTestCommandAuthorized({ from: '5531971386091@c.us' }).allowed,
    true,
    'número administrativo deve ser autorizado com DDI',
  );

  assert.strictEqual(
    isTestCommandAuthorized({ from: '18885055098907@lid' }).allowed,
    true,
    'LID administrativo deve ser autorizado',
  );
  assert.strictEqual(
    isTesterIdentity({ from: '18885055098907@lid' }),
    true,
    'o administrador configurado deve ser reconhecido como tester',
  );

  assert.strictEqual(
    isTestCommandAuthorized({ from: '5511999999999@c.us' }).allowed,
    false,
    'outro cliente não pode executar comando administrativo',
  );

  process.env.TEST_COMMAND_ALLOWED_CLIENT_NUMBERS = '';
  process.env.TEST_COMMAND_ALLOWED_CHAT_IDS = '';
  process.env.TEST_COMMAND_LID_NUMBER_MAP = '';

  assert.strictEqual(
    isTestCommandAuthorized({ from: '5531971386091@c.us' }).allowed,
    false,
    'sem administradores configurados o padrão deve negar todos',
  );

  delete process.env.TEST_COMMAND_ALLOWED_CLIENT_NUMBERS;
  delete process.env.TEST_COMMAND_ALLOWED_CHAT_IDS;
  delete process.env.TEST_COMMAND_LID_NUMBER_MAP;
  process.env.ALLOWED_CLIENT_NUMBERS = '31971386091';
  process.env.ALLOWED_CHAT_IDS = '18885055098907@lid';
  process.env.LID_NUMBER_MAP = '18885055098907@lid=31971386091';

  assert.strictEqual(
    isTesterIdentity({ from: '18885055098907@lid' }),
    true,
    'a whitelist local deve servir como fallback quando não há whitelist administrativa separada',
  );

  console.log('✅ Whitelist administrativa dos comandos verificada');
} finally {
  restore();
}
