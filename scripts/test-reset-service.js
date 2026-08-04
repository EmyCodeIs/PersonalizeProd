'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const originalCwd = process.cwd();
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'personalize-reset-service-'));
process.chdir(tempDir);

process.env.MOCK_MODE = 'true';
process.env.MAINTENANCE_INTERVAL_MS = '60000';
process.env.BOT_ACTIVITY_TTL_DAYS = '30';

async function main() {
  const Store = require('../src/services/leadStore');
  const HumanControl = require('../src/services/humanControlStore');
  const BotActivity = require('../src/services/botActivityStore');
  const ResetCheckpoint = require('../src/services/resetCheckpointStore');
  const { BufferManager } = require('../src/core/bufferManager');
  const {
    RESET_MODE,
    formatResetConfirmation,
    resetConversation,
  } = require('../src/core/resetService');

  const testerId = '5531999999910@c.us';
  const customerId = '5531999999920@c.us';

  const testerSession = Store.getSession(testerId);
  testerSession.etapa = 'cidade';
  testerSession.dados = { flow: 'letreiro', nome: 'Tester' };
  Store.saveSession(testerSession);
  Store.beginCustomerConversation(testerId, { name: 'Tester' });

  const customerSession = Store.getSession(customerId);
  customerSession.etapa = 'tamanho';
  customerSession.dados = { flow: 'letreiro', nome: 'Cliente real' };
  Store.saveSession(customerSession);
  Store.beginCustomerConversation(customerId, { name: 'Cliente real' });

  HumanControl.setBlock(testerId, {
    reason: 'manual_outbound_message',
    source: 'manual_outbound_message',
    persistent: true,
  });
  HumanControl.setBlock(customerId, {
    reason: 'seller_label',
    source: 'seller_label',
    seller: 'ana',
    labelName: 'Ana',
    persistent: true,
  });

  BotActivity.markBotOutbound(testerId, {
    at: '2026-08-04T10:00:00.000Z',
    messageId: 'bot-before-reset',
    type: 'text',
  });

  const buffer = new BufferManager({
    delayMs: 60000,
    onFlush: async () => {},
  });
  buffer.push(testerId, { text: 'mensagem antiga do tester' }, { delayMs: 60000 });
  buffer.push(customerId, { text: 'mensagem do cliente real' }, { delayMs: 60000 });
  assert.equal(buffer.map.has(testerId), true);
  assert.equal(buffer.map.has(customerId), true);

  const result = await resetConversation({
    clientId: testerId,
    mode: RESET_MODE.TESTER_FULL,
    command: '/resetarsys',
    actor: 'teste_automatizado',
    messageId: 'reset-command-id',
    clearBuffer: (chatId) => BufferManager.clearAllFor(chatId),
    cleanupExternal: async ({ candidates }) => ({
      note: { cleared: true, found: 1, candidates },
      labels: { requested: 4, removed: 4, remaining: 0, error: null },
    }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.mode, RESET_MODE.TESTER_FULL);
  assert.equal(buffer.map.has(testerId), false, 'buffer do tester precisa ser apagado');
  assert.equal(buffer.map.has(customerId), true, 'buffer de outro cliente precisa ser preservado');

  const testerAfter = Store.getSession(testerId);
  assert.equal(testerAfter.etapa, 'inicio');
  assert.deepEqual(testerAfter.dados, {});
  assert.equal(Store.getCustomerProfile(testerId), null);
  assert.equal(HumanControl.getBlock(testerId).blocked, false);

  const customerAfter = Store.getSession(customerId);
  assert.equal(customerAfter.etapa, 'tamanho');
  assert.equal(customerAfter.dados.nome, 'Cliente real');
  assert.equal(Store.getCustomerProfile(customerId).knownName, 'Cliente real');
  assert.equal(HumanControl.getBlock(customerId).blocked, true);

  const checkpoint = ResetCheckpoint.getLastReset(testerId);
  assert.equal(checkpoint.messageId, 'reset-command-id');
  assert.equal(checkpoint.mode, RESET_MODE.TESTER_FULL);

  const recoveryCheckpoint = BotActivity.getLastBotOutbound(testerId);
  assert.equal(recoveryCheckpoint.type, 'reset');
  assert.equal(recoveryCheckpoint.messageId, 'reset-command-id');
  assert.equal(
    new Date(recoveryCheckpoint.at).getTime() >= new Date('2026-08-04T10:00:00.000Z').getTime(),
    true,
  );

  assert.match(formatResetConfirmation(result), /conversa, bloqueio, nota e etiquetas foram limpos/i);

  buffer.destroy();
  console.log('✅ Reset único verificado: limpa somente tester, preserva outros clientes e cria checkpoint de histórico.');
}

main()
  .catch((error) => {
    console.error('❌ Teste do ResetService falhou:', error?.stack || error?.message || error);
    process.exitCode = 1;
  })
  .finally(() => {
    process.chdir(originalCwd);
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
  });
