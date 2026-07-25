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

function firstNonEmptyList(...values) {
  for (const value of values) {
    const parsed = splitList(value);
    if (parsed.length) return parsed;
  }
  return [];
}

function commandAdminConfig() {
  const explicitTestConfig = [
    process.env.TEST_COMMAND_ALLOWED_CLIENT_NUMBERS,
    process.env.TEST_COMMAND_ALLOWED_CHAT_IDS,
  ].some((value) => String(value || '').trim().length > 0);
  const explicitAdminConfig = [
    process.env.ADMIN_WHATSAPP_NUMBERS,
    process.env.ADMIN_WHATSAPP_CHAT_IDS,
  ].some((value) => String(value || '').trim().length > 0);

  let allowedNumbers = [];
  let allowedChatIds = [];
  let source = 'none';

  if (explicitTestConfig) {
    allowedNumbers = splitList(process.env.TEST_COMMAND_ALLOWED_CLIENT_NUMBERS);
    allowedChatIds = splitList(process.env.TEST_COMMAND_ALLOWED_CHAT_IDS);
    source = 'test_command';
  } else if (explicitAdminConfig) {
    allowedNumbers = splitList(process.env.ADMIN_WHATSAPP_NUMBERS);
    allowedChatIds = splitList(process.env.ADMIN_WHATSAPP_CHAT_IDS);
    source = 'admin_whatsapp';
  } else {
    allowedNumbers = splitList(process.env.ALLOWED_CLIENT_NUMBERS);
    allowedChatIds = splitList(process.env.ALLOWED_CHAT_IDS);
    source = 'allowed_clients';
  }

  return {
    allowedNumbers,
    allowedChatIds,
    source,
    lidMap: {
      ...parseMap(process.env.LID_NUMBER_MAP),
      ...parseMap(process.env.TEST_COMMAND_LID_NUMBER_MAP),
    },
  };
}

function serializeCandidate(value) {
  if (!value) return '';
  if (typeof value === 'object') {
    return String(value._serialized || value.id?._serialized || value.id || '').trim();
  }
  return String(value).trim();
}

function collectCandidates({ from, raw } = {}, lidMap = {}) {
  const fromKey = serializeCandidate(from).toLowerCase();
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

  return [...new Set(values.map(serializeCandidate).filter(Boolean))];
}

function isTestCommandAuthorized({ from, raw } = {}) {
  const config = commandAdminConfig();
  const allowedChatIds = config.allowedChatIds
    .map((item) => String(item || '').trim().toLowerCase())
    .filter(Boolean);
  const allowedNumbers = config.allowedNumbers.map(onlyDigits).filter(Boolean);

  if (!allowedChatIds.length && !allowedNumbers.length) {
    return { allowed: false, reason: 'nenhum_admin_configurado', configSource: config.source };
  }

  const candidates = collectCandidates({ from, raw }, config.lidMap);
  for (const candidate of candidates) {
    const lower = candidate.toLowerCase();
    if (allowedChatIds.includes(lower)) {
      return { allowed: true, reason: 'chat_id', matched: candidate, configSource: config.source };
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
        return { allowed: true, reason: 'numero', matched: candidate, configSource: config.source };
      }
    }
  }

  return {
    allowed: false,
    reason: 'fora_da_whitelist_administrativa',
    configSource: config.source,
    candidates: candidates.slice(0, 8),
  };
}

function isTesterIdentity({ from, raw } = {}) {
  return isTestCommandAuthorized({ from, raw }).allowed;
}

module.exports = {
  collectCandidates,
  commandAdminConfig,
  firstNonEmptyList,
  isTesterIdentity,
  isTestCommandAuthorized,
  lastDigits,
  onlyDigits,
  parseMap,
  serializeCandidate,
  splitList,
};
