'use strict';

process.env.MOCK_MODE = 'true';
process.env.MIN_REPLY_DELAY_MS = '0';
process.env.MAX_REPLY_DELAY_MS = '0';

const readline = require('readline');
const { BufferManager, mergeMessages } = require('../src/core/bufferManager');
const { processCustomerMessage } = require('../src/flow/customerFlow');
const { createMockChannel } = require('../src/services/wppconnectClient');
const Store = require('../src/services/leadStore');

const CLIENT_ID = '5531999999999';
const channel = createMockChannel();

const buffer = new BufferManager({
  delayMs: 600,
  onFlush: async (clientId, messages) => {
    const text = mergeMessages(messages);
    await processCustomerMessage({ clientId, text, channel });
  },
});

console.log('Simulador do fluxo cliente Personalize + WPPConnect');
console.log('Digite como se fosse o cliente. Use /reset para reiniciar. Ctrl+C para sair.');
console.log('Exemplo inicial: Oi, vim pelo site e quero um letreiro de acrílico. Meu nome é Emilly, tel 31999999999');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '\nCLIENTE> ' });
rl.prompt();

rl.on('line', (line) => {
  const text = String(line || '').trim();
  if (!text) return rl.prompt();
  if (/^\/(reset|reiniciar)$/i.test(text)) {
    Store.resetSession(CLIENT_ID);
    console.log('[SISTEMA] sessão local reiniciada.');
    return rl.prompt();
  }
  buffer.push(CLIENT_ID, { text });
  setTimeout(() => rl.prompt(), 750);
});
