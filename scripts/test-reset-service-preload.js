'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const originalCwd = process.cwd();
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'personalize-reset-preload-'));
process.chdir(tempDir);
process.env.MOCK_MODE = 'true';
process.env.MAINTENANCE_INTERVAL_MS = '60000';

async function main() {
  const WppClient = require('../src/services/wppconnectClient');
  const Store = require('../src/services/leadStore');
  const HumanControl = require('../src/services/humanControlStore');

  const testerId = '5531999999931@c.us';
  const otherId = '5531999999932@c.us';

  const tester = Store.getSession(testerId);
  tester.etapa = 'cidade';
  tester.dados = { flow: 'letreiro' };
  Store.saveSession(tester);

  const other = Store.getSession(otherId);
  other.etapa = 'tamanho';
  other.dados = { flow: 'letreiro' };
  Store.saveSession(other);

  HumanControl.setBlock(testerId, {
    reason: 'manual_label',
    source: 'manual_label_event',
    labelName: 'Fornecedor',
  });
  HumanControl.setBlock(otherId, {
    reason: 'seller_label',
    source: 'seller_label',
    seller: 'ana',
    labelName: 'Ana',
  });

  let forwarded = 0;
  const sent = [];
  const originalCreate = WppClient.createWppChannel;
  WppClient.createWppChannel = async (options = {}) => ({
    sendText: async (clientId, text) => {
      sent.push({ clientId, text });
      return true;
    },
    emitIncoming: (payload) => options.onMessage?.(payload),
  });
  delete WppClient.__unifiedResetServiceInstalled;
  delete require.cache[require.resolve('../src/core/resetServicePreload')];
  require('../src/core/resetServicePreload');

  const channel = await WppClient.createWppChannel({
    onMessage: async () => { forwarded += 1; },
  });

  const result = await channel.emitIncoming({
    from: testerId,
    text: '/resetarsys',
    source: 'manual-test-command',
    raw: {
      from: testerId,
      fromMe: true,
      type: 'chat',
      body: '/resetarsys',
      id: { _serialized: 'reset-preload-id' },
    },
  });

  assert.equal(forwarded, 0, '/resetarsys não pode chegar ao fluxo legado');
  assert.equal(result.clientId, testerId);
  assert.equal(Store.getSession(testerId).etapa, 'inicio');
  assert.equal(HumanControl.getBlock(testerId).blocked, false);
  assert.equal(Store.getSession(otherId).etapa, 'tamanho');
  assert.equal(HumanControl.getBlock(otherId).blocked, true);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /Sistema resetado para teste/);

  await channel.emitIncoming({
    from: testerId,
    text: 'Olá',
    raw: { from: testerId, fromMe: false, type: 'chat', body: 'Olá' },
  });
  assert.equal(forwarded, 1, 'mensagem comum precisa continuar chegando ao fluxo');

  WppClient.createWppChannel = originalCreate;
  delete WppClient.__unifiedResetServiceInstalled;

  console.log('✅ Preload do reset verificado: intercepta uma vez, preserva outros clientes e não alcança o fluxo legado.');
}

main()
  .catch((error) => {
    console.error('❌ Teste do preload de reset falhou:', error?.stack || error?.message || error);
    process.exitCode = 1;
  })
  .finally(() => {
    process.chdir(originalCwd);
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
  });
