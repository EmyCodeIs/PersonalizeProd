'use strict';

const assert = require('assert/strict');

process.env.SERVICE_LABEL_LETREIRO = 'Orçamento letreiros';
process.env.SERVICE_LABEL_PLOTAGEM = 'Plotagens';
process.env.SERVICE_LABEL_OUTROS = 'Outros';
process.env.SERVICE_LABEL_SUPPORT = 'Suporte';
process.env.SELLER_LABEL_RULES = 'Adriano=#8FD0A8;Ana=#00A4F2;Emy=#7FE51F;C. Eduardo=#FEB100';

const {
  LABEL_CATEGORY,
  classifyLabel,
  selectLabelIdsForReset,
} = require('../src/core/labelPolicy');

const labels = [
  { id: '1', name: 'Orçamento letreiros' },
  { id: '2', name: 'Plotagens' },
  { id: '3', name: 'Suporte' },
  { id: '4', name: 'Ana' },
  { id: '5', name: 'C. Eduardo' },
  { id: '6', name: 'Acompanhar' },
  { id: '7', name: 'Fornecedor' },
  { id: '8', name: 'Personalize' },
  { id: '9', name: 'Voltar' },
];

assert.equal(classifyLabel(labels[0]).category, LABEL_CATEGORY.OPERATIONAL);
assert.equal(classifyLabel(labels[3]).category, LABEL_CATEGORY.SELLER);
assert.equal(classifyLabel(labels[5]).category, LABEL_CATEGORY.MANUAL);
assert.equal(classifyLabel(labels[0]).blocks, false);
assert.equal(classifyLabel(labels[3]).blocks, true);
assert.equal(classifyLabel(labels[5]).blocks, true);

assert.deepEqual(
  selectLabelIdsForReset(labels, { mode: 'TESTER_FULL' }).sort(),
  labels.map((item) => item.id).sort(),
  'o reset completo do tester precisa remover todas as etiquetas do contato',
);

assert.deepEqual(
  selectLabelIdsForReset(labels, { mode: 'OPERATIONAL_ONLY' }).sort(),
  ['1', '2', '3'],
  'a política central precisa continuar distinguindo as etiquetas operacionais',
);

console.log('✅ Política de etiquetas/reset verificada: operacional não bloqueia; externas bloqueiam; tester remove todas.');
