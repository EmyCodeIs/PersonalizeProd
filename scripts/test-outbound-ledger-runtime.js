'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const originalCwd = process.cwd();
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'personalize-outbound-runtime-'));
process.chdir(tempDir);
process.env.STORAGE_DRIVER = 'file';
process.env.OUTBOUND_LEDGER_ENABLED = 'true';

(async () => {
  try {
    const WppClient = require('../src/services/wppconnectClient');
    const CustomerFlow = require('../src/flow/customerFlow');
    let textSends = 0;
    let listSends = 0;
    let fileSends = 0;

    const client = {
      async sendText() {
        textSends += 1;
        return { id: { _serialized: `text-${textSends}` } };
      },
      async sendListMessage() {
        listSends += 1;
        return { id: { _serialized: `list-${listSends}` } };
      },
      async sendFile() {
        fileSends += 1;
        return { id: { _serialized: `file-${fileSends}` } };
      },
    };
    const channel = {
      client,
      async sendText(clientId, text) { return client.sendText(clientId, text); },
    };

    WppClient.createWppChannel = async () => channel;
    CustomerFlow.processCustomerMessage = async (args) => {
      await args.channel.sendText(args.clientId, 'Resposta registrada');
      await args.channel.client.sendListMessage(args.clientId, {
        title: 'Escolha',
        description: 'Selecione uma opção',
        buttonText: 'Abrir',
        sections: [{ title: 'Opções', rows: [{ id: 'a', title: 'Opção A' }] }],
      });
      return true;
    };

    delete require.cache[require.resolve('../src/core/outboundLedgerPreload')];
    require('../src/core/outboundLedgerPreload');
    const wrappedChannel = await WppClient.createWppChannel();

    const args = {
      clientId: '5531999999703@c.us',
      channel: wrappedChannel,
      messages: [{ raw: { __personalizeInboxId: 'msg:inbound-runtime-1' } }],
    };
    await CustomerFlow.processCustomerMessage(args);
    await CustomerFlow.processCustomerMessage(args);

    assert.equal(textSends, 1, 'texto da mesma execução persistente não pode ser duplicado');
    assert.equal(listSends, 1, 'lista da mesma execução persistente não pode ser duplicada');

    const txtPath = path.join(tempDir, 'lead.txt');
    fs.writeFileSync(txtPath, 'conteúdo do relatório', 'utf8');
    await wrappedChannel.sendTxtDocument(
      '5531999999704@c.us',
      txtPath,
      'lead.txt',
      'Conversa completa',
      { ledgerOperationKey: 'alert:test:txt' },
    );
    await wrappedChannel.sendTxtDocument(
      '5531999999704@c.us',
      txtPath,
      'lead.txt',
      'Conversa completa',
      { ledgerOperationKey: 'alert:test:txt' },
    );
    assert.equal(fileSends, 1, 'TXT do mesmo alerta não pode ser reenviado');

    const Ledger = require('../src/services/outboundLedgerStore');
    const records = Ledger.listAll();
    assert.equal(records.filter((record) => record.status === Ledger.STATUS.SENT).length, 3);
    assert.ok(records.some((record) => record.type === 'text'));
    assert.ok(records.some((record) => record.type === 'list'));
    assert.ok(records.some((record) => record.type === 'text_document'));

    console.log('✅ Runtime do ledger: texto, lista, TXT e idempotência por mensagem recebida verificados.');
  } finally {
    process.chdir(originalCwd);
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
