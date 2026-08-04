'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const originalCwd = process.cwd();
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'personalize-lead-operation-'));
process.chdir(tempDir);
process.env.STORAGE_DRIVER = 'file';

function freshStore() {
  for (const modulePath of [
    '../src/services/leadOperationStore',
    '../src/services/persistence',
    '../src/config/leadOperationsConfig',
  ]) {
    try { delete require.cache[require.resolve(modulePath)]; } catch (_) {}
  }
  return require('../src/services/leadOperationStore');
}

try {
  let Operations = freshStore();
  const lead = {
    conversationKey: 'wa:5531999999741@c.us',
    clientId: '5531999999741@c.us',
    phone: '5531999999741',
    customerName: 'Cliente Operacional',
    service: 'letreiro',
    stage: 'cidade',
    lastCustomerMessageAt: '2026-08-03T10:00:00.000Z',
    idleHours: 25,
  };

  const created = Operations.ensureLead(lead);
  assert.equal(created.status, Operations.STATUS.PENDING);
  assert.equal(created.audit[0].action, 'LEAD_CREATED');

  const duplicate = Operations.ensureLead({ ...lead, idleHours: 27 });
  assert.equal(duplicate.id, created.id);
  assert.equal(duplicate.idleHours, 27);
  assert.equal(Operations.listAll().length, 1);

  let updated = Operations.updateStatus({
    id: created.id,
    status: 'SEEN',
    actor: 'Ana',
    assignedTo: 'Ana',
    note: 'Vou entrar em contato.',
  });
  assert.equal(updated.status, Operations.STATUS.SEEN);
  assert.ok(updated.seenAt);
  assert.equal(updated.assignedTo, 'Ana');

  updated = Operations.updateStatus({
    id: created.id,
    status: 'CONTACTED',
    actor: 'Ana',
    note: 'Contato realizado pelo WhatsApp pessoal.',
  });
  assert.equal(updated.status, Operations.STATUS.CONTACTED);
  assert.ok(updated.contactedAt);
  assert.equal(updated.audit.at(-1).toStatus, Operations.STATUS.CONTACTED);

  Operations.recordAlert({
    id: created.id,
    status: 'SENT',
    recipients: ['5531999999000@c.us'],
    reportPath: '/tmp/lead.txt',
  });
  const alerted = Operations.getById(created.id);
  assert.equal(alerted.alertStatus, 'SENT');
  assert.equal(alerted.alertAttempts, 1);
  assert.equal(alerted.audit.at(-1).action, 'ALERT_SENT');

  Operations = freshStore();
  const restored = Operations.getById(created.id);
  assert.equal(restored.status, Operations.STATUS.CONTACTED);
  assert.equal(restored.alertStatus, 'SENT');
  assert.ok(restored.audit.length >= 4);

  assert.throws(() => Operations.updateStatus({ id: created.id, status: 'INVALID' }), /LEAD_STATUS_INVALID/);
  console.log('✅ Operação de leads: status, responsável, observação, alerta, auditoria e reinício verificados.');
} finally {
  process.chdir(originalCwd);
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
}
