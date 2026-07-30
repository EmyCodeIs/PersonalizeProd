'use strict';

const assert = require('assert/strict');

for (const key of [
  'BEM_VINDOS_LINK_URL',
  'MOSTRUARIO_CATALOG_NAME',
  'SERVICE_LABEL_LETREIRO',
  'SERVICE_LABEL_PLOTAGEM',
  'SERVICE_LABEL_OUTROS',
  'SERVICE_LABEL_SUPPORT',
  'SERVICE_LABEL_REPLACE_GROUP',
]) {
  delete process.env[key];
}

const {
  DEFAULT_CATALOG_NAME,
  INSTAGRAM_WELCOME_URL,
  env,
} = require('../src/config/env');
const { messages } = require('../src/core/messages');
const { menus } = require('../src/core/menuCatalog');

const serviceRows = Object.fromEntries(menus.servicos.rows.map((row) => [row.id, row]));
assert.equal(serviceRows.serv_letreiro.description, 'Solicitar orçamento do meu letreiro');
assert.equal(serviceRows.serv_plotagem.description, 'Vitrines, paredes, veículos e adesivos');
assert.equal(serviceRows.serv_outros.description, 'Placas, fachadas e outros serviços');
assert.equal(serviceRows.serv_suporte.description, 'Dúvidas ou atendimento com nossa equipe');
assert.equal(menus.servicos.rows.length, 4, 'a lista deve ter quatro opções estáticas, sem mutação por preload');
assert.equal(JSON.stringify(menus.servicos.rows).includes('Coletar dados da solicitação'), false);

assert.equal(env.bemVindosLinkUrl, INSTAGRAM_WELCOME_URL);
assert.equal(env.mostruarioCatalogName, DEFAULT_CATALOG_NAME);
assert.equal(env.serviceLabelLetreiro, 'Orçamento letreiros');
assert.deepEqual(env.serviceLabelReplaceGroup, [
  'Orçamento letreiros',
  'Plotagens',
  'Outros',
  'Suporte',
]);

assert.equal(
  messages.letteringBudgetIntro,
  'Para orçarmos seu letreiro, preciso de algumas informações. Vamos começar pelo tipo de acrílico:',
);
assert.equal(messages.askObservationWrite, 'Perfeito! Pode me contar o que gostaria de acrescentar?');
assert.equal(messages.askGeneralObservationText, 'Perfeito! Pode me contar o que gostaria de acrescentar?');
assert.equal(
  messages.completedContactNote,
  'Certo! Seu pedido foi registrado e encaminhado para nossa equipe. Em breve, um vendedor continuará o atendimento por aqui. 😊',
);

const sellerEventSource = require('fs').readFileSync(require('path').join(__dirname, '../src/core/sellerLabelEventsPreload.js'), 'utf8');
assert.equal(sellerEventSource.includes('onUpdateLabel'), true, 'o monitor de alteração de etiquetas precisa continuar registrado');

const serializedMessages = JSON.stringify(messages);
assert.equal(
  serializedMessages.includes('Quando você parar por alguns segundos'),
  false,
  'o texto técnico do buffer não pode voltar para o cliente',
);
assert.equal(
  serializedMessages.includes('Se quiser acrescentar alguma informação ou tiver alguma dúvida'),
  false,
  'o texto antigo de finalização não pode voltar',
);
assert.equal(serializedMessages.includes('Confira nosso mostruário de *Letreiros e Cores*'), false);
assert.equal(serializedMessages.includes('🔗 Ver Mostruário'), false);

console.log('✅ Configuração comercial atual verificada: Instagram, catálogo, etiquetas e textos.');
