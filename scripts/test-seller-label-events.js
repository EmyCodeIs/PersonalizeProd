'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const originalCwd = process.cwd();
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'personalize-seller-event-'));
process.chdir(tempDir);
process.env.MOCK_MODE = 'true';

async function main() {
  const Store = require('../src/services/leadStore');
  const HumanControl = require('../src/services/humanControlStore');
  const {
    createSellerLabelUpdateHandler,
    extractLabelUpdateChatId,
  } = require('../src/core/sellerLabelEvents');

  const sellerClientId = '5531999999922@c.us';
  const sellerSession = Store.getSession(sellerClientId);
  sellerSession.completed = true;
  sellerSession.etapa = 'concluido';
  sellerSession.dados = { botDone: true, flow: 'letreiro' };
  Store.saveSession(sellerSession);

  assert.equal(
    extractLabelUpdateChatId({ chat: { id: { _serialized: sellerClientId } } }),
    sellerClientId,
  );

  let clearCount = 0;
  const handler = createSellerLabelUpdateHandler({
    getChannel: () => ({ client: {}, __isInternalLabelOperation: () => false }),
    clearBuffer: () => { clearCount += 1; },
    delayMs: 0,
  });

  const assigned = await handler({
    data: {
      chat: { id: { _serialized: sellerClientId } },
      labels: [{ name: 'Ana' }],
      type: 'add',
    },
  });

  assert.equal(assigned.assigned, true);
  assert.equal(assigned.blocked, true);
  assert.equal(clearCount, 1);
  assert.equal(HumanControl.getBlock(sellerClientId).blocked, true);
  assert.equal(HumanControl.getBlock(sellerClientId).control.reason, 'seller_label');
  assert.equal(HumanControl.getBlock(sellerClientId).control.blockedUntil, null);

  const assignedSession = Store.listSessions().find((item) => item.id === sellerSession.id);
  assert.equal(assignedSession.completed, true, 'evento de vendedor não pode reabrir atendimento concluído');
  assert.equal(assignedSession.dados.sellerHandoff.status, 'assigned');
  assert.equal(assignedSession.dados.sellerHandoff.seller, 'ana');

  const removed = await handler({
    data: {
      chat: { id: { _serialized: sellerClientId } },
      labels: [{ name: 'Ana' }],
      type: 'remove',
    },
  });

  assert.equal(removed.removed, true);
  assert.equal(removed.blocked, true);
  assert.equal(removed.released, false);
  assert.equal(HumanControl.getBlock(sellerClientId).blocked, true, 'remoção não pode liberar o bot');

  const afterRemovalSession = Store.listSessions().find((item) => item.id === sellerSession.id);
  assert.equal(afterRemovalSession.dados.sellerHandoff.status, 'assigned');
  assert.equal(afterRemovalSession.dados.sellerHandoff.releasedAt, null);

  const operationalClientId = '5531999999923@c.us';
  Store.getSession(operationalClientId);
  const operational = await handler({
    data: {
      chat: { id: { _serialized: operationalClientId } },
      labels: [{ name: 'Orçamento letreiros' }],
      type: 'add',
    },
  });

  assert.equal(operational.blocked, false, 'etiqueta operacional não pode gerar handoff');
  assert.equal(HumanControl.getBlock(operationalClientId).blocked, false);

  const manualClientId = '5531999999924@c.us';
  Store.getSession(manualClientId);
  const manual = await handler({
    data: {
      chat: { id: { _serialized: manualClientId } },
      labels: [{ name: 'Fornecedor' }],
      type: 'add',
    },
  });

  assert.equal(manual.assigned, true);
  assert.equal(manual.blocked, true);
  assert.equal(manual.guard.reason, 'manual_label');
  assert.equal(HumanControl.getBlock(manualClientId).blocked, true);
  assert.equal(HumanControl.getBlock(manualClientId).control.blockedUntil, null);

  console.log('✅ Eventos de etiqueta protegidos: vendedor/manual bloqueiam, operacional não bloqueia e remoção não libera.');
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
