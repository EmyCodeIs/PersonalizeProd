'use strict';

const CONTROL_OR_INVISIBLE_RE = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/u;
const REPLACEMENT_CHARACTER_RE = /\uFFFD/u;
const LETTER_OR_NUMBER_RE = /[\p{L}\p{N}]/u;
const SYMBOL_OR_PUNCTUATION_RE = /[\p{P}\p{S}]/u;
const EXTENDED_PICTOGRAPHIC_RE = /\p{Extended_Pictographic}/u;

function hasUnpairedSurrogate(value) {
  const text = String(value || '');
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0xD800 && code <= 0xDBFF) {
      const next = text.charCodeAt(index + 1);
      if (!(next >= 0xDC00 && next <= 0xDFFF)) return true;
      index += 1;
      continue;
    }
    if (code >= 0xDC00 && code <= 0xDFFF) return true;
  }
  return false;
}

function hasUnicodeNoncharacter(value) {
  for (const character of String(value || '')) {
    const codePoint = character.codePointAt(0);
    if (
      (codePoint >= 0xFDD0 && codePoint <= 0xFDEF)
      || (codePoint & 0xFFFF) === 0xFFFE
      || (codePoint & 0xFFFF) === 0xFFFF
    ) return true;
  }
  return false;
}

function cleanedVisibleName(value) {
  return String(value || '')
    .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF\uFFFD]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function classifyCorruptLabelName(value) {
  const raw = String(value ?? '');
  const reasons = [];

  if (!raw.trim()) reasons.push('empty_name');
  if (REPLACEMENT_CHARACTER_RE.test(raw)) reasons.push('replacement_character');
  if (CONTROL_OR_INVISIBLE_RE.test(raw)) reasons.push('control_or_invisible_character');
  if (hasUnpairedSurrogate(raw)) reasons.push('unpaired_surrogate');
  if (hasUnicodeNoncharacter(raw)) reasons.push('unicode_noncharacter');

  const cleaned = cleanedVisibleName(raw);
  if (!cleaned) {
    if (!reasons.includes('empty_name')) reasons.push('empty_after_cleanup');
  } else {
    const hasLetterOrNumber = LETTER_OR_NUMBER_RE.test(cleaned);
    const hasEmoji = EXTENDED_PICTOGRAPHIC_RE.test(cleaned);
    const hasOnlySymbolsOrPunctuation = !hasLetterOrNumber
      && SYMBOL_OR_PUNCTUATION_RE.test(cleaned);

    // Etiquetas intencionais compostas somente por emoji continuam válidas.
    // Símbolos/pontuação sem texto, como "???" e "###", são tratados como erro.
    if (hasOnlySymbolsOrPunctuation && !hasEmoji) reasons.push('symbols_only');
  }

  return {
    corrupt: reasons.length > 0,
    reasons: [...new Set(reasons)],
    raw,
    cleaned,
  };
}

function labelNamePreview(value, maxLength = 80) {
  const escaped = JSON.stringify(String(value ?? ''));
  if (escaped.length <= maxLength) return escaped;
  return `${escaped.slice(0, Math.max(1, maxLength - 1))}…`;
}

module.exports = {
  classifyCorruptLabelName,
  cleanedVisibleName,
  hasUnicodeNoncharacter,
  hasUnpairedSurrogate,
  labelNamePreview,
};
