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

  // A regra-base também precisa ser caracterizada sem depender da ordem dos preloads.
  assert.equal(SellerHandoff._test.findSellerLabelMatch([{ name: 'Ana' }]).seller, 'ana');
  const manualAninha = SellerHandoff._test.findSellerLabelMatch([{ name: 'Aninha', hexColor: '#00a4f2' }]);
  assert.equal(manualAninha.reason, 'manual_label');
  assert.equal(manualAninha.seller, null);
  assert.equal(SellerHandoff._test.findSellerLabelMatch([{ name: 'Adriano Silva', hexColor: '#8fd0a8' }]).reason, 'manual_label');
  assert.equal(SellerHandoff._test.findSellerLabelMatch([{ name: 'Fornecedor', hexColor: '#feb100' }]).reason, 'manual_label');

  let attachedLabels = [{ id: 'seller-ana', name: 'Ana', hexColor: '#00a4f2' }];
  SellerHandoff._test.inspectChatLabels = async () => ({
    available: true,
    chatFound: true,
    items: attachedLabels,
  });
  SellerHandoff._test.orderedCandidateIds = (clientId) => [String(clientId)];

  require('../src/core/vpsReadinessPreload');

  const channel = { client: {} };
  const clientId = '5531999999933@c.us';

  const assigned = await SellerHandoff.getAutomationBlock(channel, clientId);
  assert.equal(assigned.blocked, true);
  assert.equal(assigned.reason, 'seller_label');
  assert.equal(assigned.seller, 'ana');
  assert.equal(HumanControl.getBlock(clientId).blocked, true);

  attachedLabels = [];
  const released = await SellerHandoff.getAutomationBlock(channel, clientId);
  assert.equal(released.blocked, false);
  assert.equal(released.source, 'seller_label_removed');
  assert.equal(HumanControl.getBlock(clientId).blocked, false);

  HumanControl.setBlock(clientId, {
    reason: 'manual_outbound_message',
    source: 'manual_outbound_message',
    persistent: true,
  });

  const manual = await SellerHandoff.getAutomationBlock(channel, clientId);
  assert.equal(manual.blocked, true);
  assert.equal(manual.reason, 'manual_outbound_message');
  assert.equal(HumanControl.getBlock(clientId).control.blockedUntil, null);

  const readiness = require('../src/core/vpsReadinessPreload');
  const collision = readiness.findExactSellerLabel([
    { id: 'manual', name: 'fornecedor', hexColor: '#feb100' },
    { id: 'seller', name: 'C. Eduardo', hexColor: '#feb100' },
  ]);
  assert.equal(collision.seller, 'c. eduardo');
  assert.equal(readiness.findExactSellerLabel([{ name: 'Adriano Silva' }]), null);

  const { resolveSellerLabelCandidates } = require('../src/core/sellerAliasHandoffPreload');
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

  console.log('✅ Handoff verificado: vendedor exato, aliases, liberação segura e atendimento manual.');
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
