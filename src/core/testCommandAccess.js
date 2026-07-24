'use strict';

function onlyDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

function lastDigits(value, size = 11) {
  const digits = onlyDigits(value);
  return digits.slice(-size);
}

function splitList(value) {
  return String(value || '')
    .split(/[;,\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseMap(value) {
  return splitList(value).reduce((acc, item) => {
    const separator = item.indexOf('=');
    if (separator <= 0) return acc;
    const key = item.slice(0, separator).trim().toLowerCase();
    const mapped = item.slice(separator + 1).trim();
    if (key && mapped) acc[key] = mapped;
    return acc;
  }, {});
}

function commandAdminConfig() {
  const explicitAdminConfig = [
    'TEST_COMMAND_ALLOWED_CLIENT_NUMBERS',
    'TEST_COMMAND_ALLOWED_CHAT_IDS',
    'TEST_COMMAND_LID_NUMBER_MAP',
  ].some((name) => process.env[name] !== undefined);

  return {
    allowedNumbers: splitList(
      explicitAdminConfig
        ? process.env.TEST_COMMAND_ALLOWED_CLIENT_NUMBERS
        : process.env.ALLOWED_CLIENT_NUMBERS,
    ),
    allowedChatIds: splitList(
      explicitAdminConfig
        ? process.env.TEST_COMMAND_ALLOWED_CHAT_IDS
        : process.env.ALLOWED_CHAT_IDS,
    ),
    lidMap: {
      ...parseMap(process.env.LID_NUMBER_MAP),
      ...parseMap(process.env.TEST_COMMAND_LID_NUMBER_MAP),
    },
  };
}

function collectCandidates({ from, raw } = {}, lidMap = {}) {
  const fromKey = String(from || '').trim().toLowerCase();
  const mapped = fromKey ? lidMap[fromKey] : null;
  const values = [
    from,
    mapped,
    raw?.resolvedNumber,
    raw?.from,
    raw?.to,
    raw?.chatId,
    raw?.sender?.id,
    raw?.sender?.id?._serialized,
    raw?.contact?.id,
    raw?.contact?.id?._serialized,
    raw?.id?.remote,
    raw?.id?._serialized,
    raw?.key?.remoteJid,
    raw?.key?.participant,
    raw?.author,
  ];

  return values
    .map((item) => String(item || '').trim())
    .filter(Boolean);
}

function isTestCommandAuthorized({ from, raw } = {}) {
  const config = commandAdminConfig();
  const allowedChatIds = config.allowedChatIds
    .map((item) => String(item || '').trim().toLowerCase())
    .filter(Boolean);
  const allowedNumbers = config.allowedNumbers.map(onlyDigits).filter(Boolean);

  // Segurança por padrão: ENABLE_TEST_COMMANDS=true sem administradores
  // configurados não libera o comando para ninguém.
  if (!allowedChatIds.length && !allowedNumbers.length) {
    return { allowed: false, reason: 'nenhum_admin_configurado' };
  }

  const candidates = collectCandidates({ from, raw }, config.lidMap);
  for (const candidate of candidates) {
    const lower = candidate.toLowerCase();
    if (allowedChatIds.includes(lower)) {
      return { allowed: true, reason: 'chat_id', matched: candidate };
    }

    const digits = onlyDigits(candidate);
    if (!digits) continue;

    for (const allowedNumber of allowedNumbers) {
      if (
        digits === allowedNumber
        || digits.endsWith(allowedNumber)
        || allowedNumber.endsWith(digits)
        || lastDigits(digits, 11) === lastDigits(allowedNumber, 11)
      ) {
        return { allowed: true, reason: 'numero', matched: candidate };
      }
    }
  }

  return {
    allowed: false,
    reason: 'fora_da_whitelist_administrativa',
    candidates: candidates.slice(0, 8),
  };
}

function isTesterIdentity({ from, raw } = {}) {
  return isTestCommandAuthorized({ from, raw }).allowed;
}

module.exports = {
  collectCandidates,
  commandAdminConfig,
  isTesterIdentity,
  isTestCommandAuthorized,
  lastDigits,
  onlyDigits,
  parseMap,
  splitList,
};
