'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const originalCwd = process.cwd();
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'personalize-flow-smoke-'));
process.chdir(tempDir);

process.env.MOCK_MODE = 'true';
process.env.ENABLE_CONTACT_LABELS = 'false';
process.env.ENABLE_CONTACT_NOTES = 'false';
process.env.MIN_REPLY_DELAY_MS = '0';
process.env.MAX_REPLY_DELAY_MS = '0';
process.env.ENABLE_TEST_COMMANDS = 'false';
process.env.MAINTENANCE_INTERVAL_MS = '60000';

async function main() {
  require('../src/core/customerFlowFixPreload');
  require('../src/core/preferredSellerNotePreload');
  require('../src/core/completedFlowSilencePreload');
  require('../src/core/runtimeReliabilityPreload');
  require('../src/core/supportAndServicesPreload');

  const Store = require('../src/services/leadStore');
  const WppClient = require('../src/services/wppconnectClient');
  const CustomerFlow = require('../src/flow/customerFlow');

  const clientId = '5531999999911@c.us';
  const events = [];
  let sequence = 0;
  const channel = WppClient.createMockChannel();

  channel.client.sendText = async (chatId, text) => {
    events.push({ type: 'text', chatId, text: String(text || '') });
    sequence += 1;
    return { id: `text-${sequence}`, fromMe: true };
  };
  channel.client.sendListMessage = async (chatId, payload) => {
    events.push({ type: 'menu', chatId, payload });
    sequence += 1;
    return { id: `menu-${sequence}`, fromMe: true };
  };
  channel.markUnread = async (chatId) => {
    events.push({ type: 'mark-unread', chatId });
    return true;
  };
  channel.setContactNote = async () => {
    throw new Error('nota não deveria ser chamada com ENABLE_CONTACT_NOTES=false');
  };

  async function send(text, messages = []) {
    return CustomerFlow.processCustomerMessage({
      clientId,
      text,
      channel,
      messages,
    });
  }

  await send('Oi');
  assert.equal(Store.getSession(clientId).etapa, 'escolher_servico');
  assert.equal(events.some((event) => event.type === 'menu'), true);

  await send('serv_outros');
  assert.equal(Store.getSession(clientId).etapa, 'outros_descricao');
  assert.equal(Store.getSession(clientId).dados.flow, 'outros');

  await send('Preciso de uma placa de identificação');
  assert.equal(Store.getSession(clientId).etapa, 'outros_referencia');

  await send('Tenho uma imagem como referência');
  assert.equal(Store.getSession(clientId).etapa, 'outros_prazo');

  await send('Sem urgência');
  assert.equal(Store.getSession(clientId).etapa, 'outros_cidade');

  await send('Belo Horizonte/MG');
  assert.equal(Store.getSession(clientId).etapa, 'outros_observacao_menu');

  await send('OBS_PEDIDO|SKIP');
  const completed = Store.getSession(clientId);
  assert.equal(completed.completed, true);
  assert.equal(completed.etapa, 'concluido');
  assert.equal(completed.dados.botDone, true);
  assert.equal(completed.dados.cidade, 'Belo Horizonte/MG');
  assert.equal(events.some((event) => event.type === 'mark-unread'), true);

  const outboundAfterCompletion = events.length;
  await send('Quero complementar uma informação');
  assert.equal(
    events.length,
    outboundAfterCompletion,
    'mensagem após conclusão deve ficar silenciosa para o vendedor',
  );

  console.log('✅ Fluxo automatizado: início → Outros → cidade → conclusão → silêncio pós-atendimento.');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    process.chdir(originalCwd);
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
  });
