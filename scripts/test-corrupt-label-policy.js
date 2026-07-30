'use strict';

const assert = require('node:assert/strict');
const {
  classifyCorruptLabelName,
  cleanedVisibleName,
  hasUnicodeNoncharacter,
  hasUnpairedSurrogate,
} = require('../src/core/labelCorruptionPolicy');

function valid(name) {
  const result = classifyCorruptLabelName(name);
  assert.equal(result.corrupt, false, `${JSON.stringify(name)} deveria ser preservada: ${result.reasons.join(',')}`);
}

function corrupt(name, expectedReason) {
  const result = classifyCorruptLabelName(name);
  assert.equal(result.corrupt, true, `${JSON.stringify(name)} deveria ser classificada como corrompida`);
  assert.ok(result.reasons.includes(expectedReason), `${JSON.stringify(name)} deveria conter motivo ${expectedReason}: ${result.reasons.join(',')}`);
}

valid('Orçamento letreiros');
valid('Fornecedor ⚠️');
valid('🔥');
valid('Pós-venda #2');
valid('R$ pendente');

corrupt('', 'empty_name');
corrupt('   ', 'empty_name');
corrupt('\uFFFD', 'replacement_character');
corrupt('Erro \uFFFD WhatsApp', 'replacement_character');
corrupt('\u200B', 'control_or_invisible_character');
corrupt('Nome\u200Boculto', 'control_or_invisible_character');
corrupt('???', 'symbols_only');
corrupt('###', 'symbols_only');
corrupt('——', 'symbols_only');
corrupt('\uD800', 'unpaired_surrogate');
corrupt(String.fromCodePoint(0xFDD0), 'unicode_noncharacter');

assert.equal(cleanedVisibleName('  Nome\u200B  válido  '), 'Nome válido');
assert.equal(hasUnpairedSurrogate('\uD800'), true);
assert.equal(hasUnpairedSurrogate('✅'), false);
assert.equal(hasUnicodeNoncharacter(String.fromCodePoint(0xFFFF)), true);
assert.equal(hasUnicodeNoncharacter('Fornecedor'), false);

console.log('✅ Etiquetas corrompidas verificadas: símbolos inválidos removíveis e nomes/emoji legítimos preservados.');
