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

  const seller = SellerHandoff._test.findSellerLabelMatch([{ name: 'Ana' }]);
  assert.equal(seller.reason, 'seller_label');
  assert.equal(seller.seller, 'ana');

  for (const labelName of ['Aninha', 'Adriano Silva', 'Fornecedor']) {
    const manual = SellerHandoff._test.findSellerLabelMatch([{ name: labelName, hexColor: '#feb100' }]);
    assert.equal(manual.reason, 'manual_label', `etiqueta externa deve bloquear: ${labelName}`);
    assert.equal(manual.seller, null);
  }

  for (const labelName of ['Orçamento letreiros', 'Plotagens', 'Outros', 'Suporte']) {
    assert.equal(
      SellerHandoff._test.findSellerLabelMatch([{ name: labelName }]),
      null,
      `etiqueta operacional não pode bloquear: ${labelName}`,
    );
  }

  let attachedLabels = [{ id: 'seller-ana', name: 'Ana', hexColor: '#00a4f2' }];
  SellerHandoff._test.inspectChatLabels = async () => ({
    available: true,
    chatFound: true,
    items: attachedLabels,
  });
  SellerHandoff._test.orderedCandidateIds = (clientId) => [String(clientId)];

  require('../src/core/vpsReadinessPreload');
  const { resolveSellerLabelCandidates } = require('../src/core/sellerAliasHandoffPreload');

  const channel = { client: {} };
  const clientId = '5531999999933@c.us';

  const assigned = await SellerHandoff.getAutomationBlock(channel, clientId);
  assert.equal(assigned.blocked, true);
  assert.equal(assigned.reason, 'seller_label');
  assert.equal(assigned.seller, 'ana');
  assert.equal(HumanControl.getBlock(clientId).blocked, true);
  assert.equal(
    HumanControl.getBlock(clientId).control.blockedUntil,
    null,
    'etiqueta externa deve criar bloqueio persistente',
  );

  attachedLabels = [];
  const removedSellerLabel = await SellerHandoff.getAutomationBlock(channel, clientId);
  assert.equal(removedSellerLabel.blocked, true, 'remover etiqueta não pode reativar o bot');
  assert.equal(removedSellerLabel.reason, 'seller_label');
  assert.equal(HumanControl.getBlock(clientId).blocked, true);

  HumanControl.clearBlock(clientId);
  attachedLabels = [{ id: 'manual-fornecedor', name: 'Fornecedor', hexColor: '#feb100' }];

  const manualLabel = await SellerHandoff.getAutomationBlock(channel, clientId);
  assert.equal(manualLabel.blocked, true);
  assert.equal(manualLabel.reason, 'manual_label');
  assert.equal(manualLabel.labelName, 'Fornecedor');
  assert.equal(HumanControl.getBlock(clientId).control.blockedUntil, null);

  attachedLabels = [];
  const removedManualLabel = await SellerHandoff.getAutomationBlock(channel, clientId);
  assert.equal(removedManualLabel.blocked, true, 'remover etiqueta manual não pode reativar o bot');
  assert.equal(removedManualLabel.reason, 'manual_label');

  HumanControl.clearBlock(clientId);
  HumanControl.setBlock(clientId, {
    reason: 'manual_outbound_message',
    source: 'manual_outbound_message',
    persistent: true,
  });

  const manualMessage = await SellerHandoff.getAutomationBlock(channel, clientId);
  assert.equal(manualMessage.blocked, true);
  assert.equal(manualMessage.reason, 'manual_outbound_message');
  assert.equal(HumanControl.getBlock(clientId).control.blockedUntil, null);

  const readiness = require('../src/core/vpsReadinessPreload');
  const collision = readiness.findExactSellerLabel([
    { id: 'manual', name: 'Fornecedor', hexColor: '#feb100' },
    { id: 'seller', name: 'C. Eduardo', hexColor: '#feb100' },
  ]);
  assert.equal(collision.seller, 'c. eduardo');
  assert.equal(readiness.findExactSellerLabel([{ name: 'Adriano Silva' }]), null);

  const resolved = await resolveSellerLabelCandidates(
    {},
    '12345678901234@lid',
    { resolvePhoneJid: async () => '5531999999999@c.us' },
  );
  assert.equal(resolved.conclusiveIdentity, true);
  assert.ok(resolved.candidates.includes('12345678901234@lid'));
  assert.ok(resolved.candidates.includes('5531999999999@c.us'));

  const unresolved = await resolveSellerLabelCandidates(
    {},
    '98765432109876@lid',
    { resolvePhoneJid: async () => null },
  );
  assert.equal(unresolved.conclusiveIdentity, false);
  assert.deepEqual(unresolved.candidates, ['98765432109876@lid']);

  console.log('✅ Handoff oficial protegido: toda etiqueta externa bloqueia e sua remoção não reativa o bot.');
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
