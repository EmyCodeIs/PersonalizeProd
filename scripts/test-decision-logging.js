'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { BufferManager } = require('../src/core/bufferManager');
const {
  decision,
  messageContext,
  metric,
  shortId,
  withDecisionContext,
} = require('../src/core/decisionLogger');
const { installDecisionChannelInstrumentation } = require('../src/core/decisionChannelInstrumentation');

async function run() {
  const output = [];
  const original = {
    log: console.log,
    warn: console.warn,
    error: console.error,
  };
  console.log = (...args) => output.push(args.join(' '));
  console.warn = (...args) => output.push(args.join(' '));
  console.error = (...args) => output.push(args.join(' '));

  try {
    const trace = messageContext({
      raw: { id: { _serialized: 'ABCD1234' } },
      chatId: '5531999999999@c.us',
      source: 'event',
      text: 'Betim',
      stage: 'cidade',
    });
    assert.equal(trace.msg, shortId('ABCD1234'));
    assert.equal(trace.etapa, 'cidade');

    const channel = {
      async sendText() { return { id: 'sent-text' }; },
      async sendImage() { return true; },
      async setContactNote() { return true; },
      async applyContactLabel() { return true; },
      async markUnread() { return false; },
      client: {
        async sendListMessage() { return true; },
      },
    };

    installDecisionChannelInstrumentation(channel);
    await withDecisionContext({ ...trace, metrics: { outbound: 0 } }, async () => {
      decision('ENTRADA', 'recebida', { texto: 'Betim' });
      await channel.sendText(trace.chat, 'Qual forma de envio?');
      await channel.client.sendListMessage(trace.chat, {
        title: 'Envio',
        sections: [{ rows: [{ id: 'retirada' }, { id: 'correios' }] }],
      });
      await channel.setContactNote(trace.chat, 'Cidade: Betim');
      await channel.applyContactLabel(trace.chat, { name: 'Orçamento letreiros', color: 'purple' });
      await channel.markUnread(trace.chat);
      assert.equal(metric('outbound'), 2, 'texto e lista devem contar como dois envios');
      assert.equal(metric('notes'), 1, 'nota deve ser contabilizada');
      assert.equal(metric('labels'), 1, 'etiqueta deve ser contabilizada');
    });

    assert.ok(output.some((line) => line.includes('ENTRADA · evento=recebida') && line.includes(`msg=${trace.msg}`)));
    assert.ok(output.some((line) => line.includes('ENVIO · evento=tentativa') && line.includes('tipo=texto')));
    assert.ok(output.some((line) => line.includes('ENVIO · evento=concluído') && line.includes('confirmado=sim')));
    assert.ok(output.some((line) => line.includes('tipo=lista') && line.includes('quantidade=2')));
    assert.ok(output.some((line) => line.includes('NOTA · evento=salva')));
    assert.ok(output.some((line) => line.includes('ETIQUETA · evento=aplicada')));
    assert.ok(output.some((line) => line.includes('RECUPERAÇÃO · evento=marcada_não_lida') && line.includes('confirmado=não')));

    const failingChannel = {
      async sendText() {
        const error = new Error('falha controlada');
        error.code = 'TEST_SEND_ERROR';
        throw error;
      },
      client: {},
    };
    installDecisionChannelInstrumentation(failingChannel);
    await assert.rejects(
      () => withDecisionContext(trace, () => failingChannel.sendText(trace.chat, 'teste')),
      /falha controlada/,
      'a instrumentação não pode engolir erro do transporte',
    );
    assert.ok(output.some((line) => line.includes('ERRO · evento=envio_falhou') && line.includes('TEST_SEND_ERROR')));

    let flushed = false;
    const buffer = new BufferManager({ delayMs: 5000, onFlush: async () => { flushed = true; } });
    buffer.push(trace.chat, { text: 'um' });
    buffer.push(trace.chat, { text: 'dois' });
    assert.equal(buffer.clear(trace.chat), 2, 'clear deve informar quantas mensagens pendentes foram descartadas');
    assert.equal(flushed, false);

    const indexSource = fs.readFileSync(path.join(__dirname, '../src/index.js'), 'utf8');
    for (const required of [
      "decision('ENTRADA', 'recebida'",
      "decision('IDENTIDADE', 'resolvida'",
      "decision('HANDOFF', 'bloqueado_antes_do_buffer'",
      "decision('BUFFER', 'agendado'",
      "decision('FILA', 'agendada'",
      "decision('FLUXO', 'concluído'",
      "decision('ADMIN', 'comando_imediato_executado'",
      "decision('RECUPERAÇÃO', 'respostas_pendentes_iniciada'",
      'installDecisionChannelInstrumentation(channel)',
    ]) {
      assert.ok(indexSource.includes(required), `integração de decisão ausente no index: ${required}`);
    }

    const wppSource = fs.readFileSync(path.join(__dirname, '../src/services/wppconnectClient.js'), 'utf8');
    assert.ok(wppSource.includes("decision('CONEXÃO', 'estado_alterado'"));
    assert.ok(wppSource.includes("decision('CONEXÃO', 'qr_disponível'"));
  } finally {
    console.log = original.log;
    console.warn = original.warn;
    console.error = original.error;
  }

  console.log('✅ Logs de decisão verificados: correlação, envio, nota, etiqueta, buffer, conexão e erro.');
}

run().catch((error) => {
  console.error('❌ Teste de logs de decisão falhou:', error?.stack || error?.message || error);
  process.exitCode = 1;
});
