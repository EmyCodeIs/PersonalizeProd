'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const originalCwd = process.cwd();
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'personalize-handoff-'));
process.chdir(tempDir);

process.env.MOCK_MODE = 'true';
process.env.SELLER_LABEL_RULES = 'Adriano=#8FD0A8;Ana=#00A4F2;Emy=#7FE51F;C. Eduardo=#FEB100';
process.env.MAINTENANCE_INTERVAL_MS = '60000';

async function run() {
  const SellerHandoff = require('../src/core/sellerHandoff');
  const HumanControl = require('../src/services/humanControlStore');

  assert.equal(SellerHandoff._test.findSellerLabelMatch([{ name: 'Ana' }]).seller, 'ana');
  assert.equal(SellerHandoff._test.findSellerLabelMatch([{ name: 'Aninha', hexColor: '#00a4f2' }]).reason, 'manual_label');
  assert.equal(SellerHandoff._test.findSellerLabelMatch([{ name: 'Adriano Silva', hexColor: '#8fd0a8' }]).reason, 'manual_label');
  assert.equal(SellerHandoff._test.findSellerLabelMatch([{ name: 'Fornecedor', hexColor: '#feb100' }]).reason, 'manual_label');
  assert.equal(SellerHandoff._test.findSellerLabelMatch([{ name: 'Plotagens' }]), null);

  let attachedLabels = [{ id: 'seller-ana', name: 'Ana', hexColor: '#00a4f2' }];
  const channel = {
    client: {
      page: {
        evaluate: async () => ({ available: true, chatFound: true, items: attachedLabels }),
      },
    },
  };
  const clientId = '5531999999933@c.us';

  const assigned = await SellerHandoff.getAutomationBlock(channel, clientId);
  assert.equal(assigned.blocked, true);
  assert.equal(assigned.reason, 'seller_label');
  assert.equal(assigned.seller, 'ana');
  assert.equal(HumanControl.getBlock(clientId).blocked, true);

  attachedLabels = [];
  const afterRemoval = await SellerHandoff.getAutomationBlock(channel, clientId);
  assert.equal(afterRemoval.blocked, true, 'remover etiqueta não pode liberar o bot');
  assert.equal(afterRemoval.reason, 'seller_label');
  assert.equal(HumanControl.getBlock(clientId).blocked, true);

  HumanControl.clearBlock(clientId);
  attachedLabels = [{ id: 'manual', name: 'Fornecedor', hexColor: '#feb100' }];
  const manualLabel = await SellerHandoff.getAutomationBlock(channel, clientId);
  assert.equal(manualLabel.blocked, true);
  assert.equal(manualLabel.reason, 'manual_label');
  assert.equal(manualLabel.seller, null);
  assert.equal(HumanControl.getBlock(clientId).control.blockedUntil, null);

  HumanControl.clearBlock(clientId);
  attachedLabels = [];
  SellerHandoff.registerManualTakeover(clientId, {
    reason: 'manual_outbound_message',
    source: 'manual_outbound_message',
  });
  const manualMessage = await SellerHandoff.getAutomationBlock(channel, clientId);
  assert.equal(manualMessage.blocked, true);
  assert.equal(manualMessage.reason, 'manual_outbound_message');
  assert.equal(HumanControl.getBlock(clientId).control.blockedUntil, null);

  const readiness = require('../src/core/vpsReadinessPreload');
  const collision = readiness.findExactSellerLabel([
    { id: 'manual', name: 'fornecedor', hexColor: '#feb100' },
    { id: 'seller', name: 'C. Eduardo', hexColor: '#feb100' },
  ]);
  assert.equal(collision.seller, 'c. eduardo');
  assert.equal(readiness.findExactSellerLabel([{ name: 'Adriano Silva' }]), null);

  const resolved = await SellerHandoff.resolveLabelCandidates(
    {},
    '12345678901234@lid',
    { resolvePhoneJid: async () => '5531999999999@c.us' },
  );
  assert.equal(resolved.conclusiveIdentity, true);
  assert.ok(resolved.candidates.includes('12345678901234@lid'));
  assert.ok(resolved.candidates.includes('5531999999999@c.us'));

  const unresolved = await SellerHandoff.resolveLabelCandidates(
    {},
    '98765432109876@lid',
    { resolvePhoneJid: async () => null },
  );
  assert.equal(unresolved.conclusiveIdentity, false);
  assert.deepEqual(unresolved.candidates, ['98765432109876@lid']);

  console.log('✅ Handoff consolidado: etiqueta externa bloqueia, remoção mantém bloqueio e aliases são protegidos.');
}

run()
  .catch((error) => {
    console.error('❌ Teste de handoff falhou:', error?.stack || error?.message || error);
    process.exitCode = 1;
  })
  .finally(() => {
    process.chdir(originalCwd);
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
  });
