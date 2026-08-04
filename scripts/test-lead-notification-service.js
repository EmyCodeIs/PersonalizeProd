'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const originalCwd = process.cwd();
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'personalize-lead-notification-'));
process.chdir(tempDir);
process.env.STORAGE_DRIVER = 'file';
process.env.ABANDONED_LEAD_HOURS = '24';
process.env.OUTBOUND_LEDGER_ENABLED = 'true';
process.env.LEAD_ALERT_ENABLED = 'true';
process.env.LEAD_ALERT_RECIPIENT_CHAT_IDS = '5531999999000@c.us';
process.env.LEAD_ALERT_SEND_TXT = 'true';

(async () => {
  try {
    const Identity = require('../src/services/contactIdentity');
    const Store = require('../src/services/leadStore');
    const Inbox = require('../src/services/messageInboxStore');
    const Cursor = require('../src/services/conversationCursorStore');
    const Operations = require('../src/services/leadOperationStore');
    const LeadNotifications = require('../src/services/leadNotificationService');

    const clientId = '5531999999751@c.us';
    Identity.registerContact({ chatId: clientId, phone: '5531999999751' });
    const session = Store.getSession(clientId);
    session.etapa = 'tipo_acrilico';
    session.dados = { flow: 'letreiro', nome: 'Lead Alerta', cidade: 'Contagem' };
    Store.saveSession(session);

    const now = Date.now();
    const messageAt = now - (25 * 3600000);
    const record = Inbox.receive({
      from: clientId,
      text: 'Quero saber o preço de um letreiro',
      raw: {
        id: { _serialized: 'lead-alert-message' },
        from: clientId,
        timestamp: messageAt / 1000,
        body: 'Quero saber o preço de um letreiro',
      },
    }).record;
    record.sourceTimestamp = messageAt;
    record.receivedAt = new Date(messageAt).toISOString();
    Inbox.writeRecord(record);
    Cursor.markProcessed(clientId, record, { session: Store.getSession(clientId) });

    let textCount = 0;
    let txtCount = 0;
    const channel = {
      async sendText(recipient, text, options) {
        textCount += 1;
        assert.equal(recipient, '5531999999000@c.us');
        assert.match(text, /LEAD PARADO HÁ 24H/);
        assert.match(options.ledgerOperationKey, /lead-alert:/);
        return true;
      },
      async sendTxtDocument(recipient, filePath, fileName, caption, options) {
        txtCount += 1;
        assert.equal(recipient, '5531999999000@c.us');
        assert.ok(fs.existsSync(filePath));
        assert.match(fs.readFileSync(filePath, 'utf8'), /Lead Alerta/);
        assert.equal(fileName.endsWith('.txt'), true);
        assert.match(caption, /Conversa completa/);
        assert.match(options.ledgerOperationKey, /:txt$/);
        return true;
      },
    };

    const panelOnly = await LeadNotifications.runLeadAlerts(channel, {
      now,
      recipients: [],
    });
    assert.equal(panelOnly.panelPending, 1);
    assert.equal(textCount, 0);
    const operationAfterPanel = Operations.listAll()[0];
    assert.equal(operationAfterPanel.alertStatus, 'PANEL_PENDING');
    assert.equal(operationAfterPanel.alertAttempts, 0);

    const sent = await LeadNotifications.runLeadAlerts(channel, { now });
    assert.equal(sent.sent, 1);
    assert.equal(sent.failed, 0);
    assert.equal(textCount, 1);
    assert.equal(txtCount, 1);
    const operation = Operations.listAll()[0];
    assert.equal(operation.alertStatus, 'SENT');
    assert.equal(operation.alertAttempts, 1);

    const duplicate = await LeadNotifications.runLeadAlerts(channel, { now: now + 60000 });
    assert.equal(duplicate.eligible, 0);
    assert.equal(textCount, 1, 'mesmo último contato não pode receber novo resumo');
    assert.equal(txtCount, 1, 'mesmo último contato não pode receber novo TXT');

    console.log('✅ Alertas de lead: painel, WhatsApp, TXT e prevenção de envio duplicado verificados.');
  } finally {
    process.chdir(originalCwd);
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
