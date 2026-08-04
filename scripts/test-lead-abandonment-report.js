'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const originalCwd = process.cwd();
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'personalize-leads-24h-'));
process.chdir(tempDir);
process.env.STORAGE_DRIVER = 'file';
process.env.ABANDONED_LEAD_HOURS = '24';

try {
  const Identity = require('../src/services/contactIdentity');
  const Store = require('../src/services/leadStore');
  const Inbox = require('../src/services/messageInboxStore');
  const Cursor = require('../src/services/conversationCursorStore');
  const LeadReport = require('../src/services/leadAbandonmentReport');

  const clientId = '5531999999721@c.us';
  Identity.registerContact({ chatId: clientId, phone: '5531999999721' });
  const session = Store.getSession(clientId);
  session.etapa = 'cidade';
  session.dados = { flow: 'letreiro', nome: 'Maria Teste', cidade: 'Belo Horizonte' };
  Store.saveSession(session);

  const now = Date.now();
  const firstAt = now - (27 * 3600000);
  const lastAt = now - (25 * 3600000);
  const first = Inbox.receive({
    from: clientId,
    text: 'Olá, quero um letreiro',
    raw: { id: { _serialized: 'lead-first' }, from: clientId, timestamp: firstAt / 1000, body: 'Olá, quero um letreiro' },
  }).record;
  const second = Inbox.receive({
    from: clientId,
    text: 'Seria para minha loja',
    raw: { id: { _serialized: 'lead-second' }, from: clientId, timestamp: lastAt / 1000, body: 'Seria para minha loja' },
  }).record;
  first.sourceTimestamp = firstAt;
  first.receivedAt = new Date(firstAt).toISOString();
  Inbox.writeRecord(first);
  second.sourceTimestamp = lastAt;
  second.receivedAt = new Date(lastAt).toISOString();
  Inbox.writeRecord(second);
  Cursor.markProcessed(clientId, second, { session: Store.getSession(clientId) });

  let report = LeadReport.buildReport({ now, thresholdHours: 24 });
  assert.equal(report.total, 1);
  assert.equal(report.pendingNotification, 1);
  assert.equal(report.leads[0].customerName, 'Maria Teste');
  assert.equal(report.leads[0].service, 'letreiro');
  assert.equal(report.leads[0].idleHours, 25);
  assert.deepEqual(report.leads[0].firstMessages.map((item) => item.text), [
    'Olá, quero um letreiro',
    'Seria para minha loja',
  ]);
  assert.equal(report.leads[0].transcriptCoverage, 'CLIENT_MESSAGES_ONLY_UNTIL_OUTBOUND_LEDGER');

  const txt = LeadReport.toTxt(report);
  assert.match(txt, /RELATÓRIO DE LEADS PARADOS/);
  assert.match(txt, /Maria Teste/);
  assert.match(txt, /CLIENTE: Olá, quero um letreiro/);

  LeadReport.markNotified(report.leads[0].conversationKey, {
    lastCustomerMessageAt: report.leads[0].lastCustomerMessageAt,
    reportId: 'report-test',
  });
  report = LeadReport.buildReport({ now, thresholdHours: 24 });
  assert.equal(report.pendingNotification, 0, 'o mesmo estado não pode gerar aviso duplicado');
  assert.equal(report.leads[0].needsNotification, false);

  const written = LeadReport.writeTxtReport({ now, thresholdHours: 24 });
  assert.ok(fs.existsSync(written.filePath));
  assert.match(fs.readFileSync(written.filePath, 'utf8'), /Seria para minha loja/);

  console.log('✅ Leads 24h: detecção, primeiras mensagens, TXT e controle de aviso duplicado verificados.');
} finally {
  process.chdir(originalCwd);
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
}
