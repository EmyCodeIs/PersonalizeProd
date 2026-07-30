'use strict';

const assert = require('assert/strict');

function cacheStub(relative, exports) {
  const filename = require.resolve(relative);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
  return exports;
}

const envPath = require.resolve('../src/config/env');
const previousFirstInput = process.env.FIRST_INPUT_BUFFER_MS;
process.env.FIRST_INPUT_BUFFER_MS = '4500';
delete require.cache[envPath];
const realEnv = require('../src/config/env').env;
assert.equal(realEnv.firstInputBufferMs, 8000, 'primeiro input não pode cair abaixo de 8 segundos');
if (previousFirstInput === undefined) delete process.env.FIRST_INPUT_BUFFER_MS;
else process.env.FIRST_INPUT_BUFFER_MS = previousFirstInput;
delete require.cache[envPath];

const calls = [];
class BufferManager {
  push(clientId, message, options = {}) {
    calls.push({ clientId, message, options });
    return options.delayMs;
  }
}

let stage = 'inicio';
cacheStub('../src/core/bufferManager', { BufferManager });
cacheStub('../src/services/leadStore', {
  getSession() { return { etapa: stage }; },
});
cacheStub('../src/config/env', {
  env: {
    firstInputBufferMs: 8000,
    supportBufferMs: 9000,
    cityBufferMs: 2500,
    observationBufferMs: 9000,
  },
});

require('../src/core/bufferStagePolicyPreload');

const buffer = new BufferManager();
assert.equal(
  buffer.push('cliente-inicial', { text: 'Oi' }, { delayMs: 4500 }),
  8000,
  'primeira mensagem precisa usar 8 segundos',
);
assert.equal(calls.at(-1).options.delayMs, 8000);
assert.equal(
  buffer.push('cliente-inicial', { text: 'Meu nome é Ana' }, { delayMs: 4500 }),
  8000,
  'cada fragmento ainda na etapa inicial precisa renovar a janela de 8 segundos',
);
assert.equal(calls.at(-1).options.delayMs, 8000);

stage = 'escolher_servico';
assert.equal(
  buffer.push('cliente-fluxo', { text: 'Letreiro' }, { delayMs: 4500 }),
  4500,
  'etapas simples posteriores precisam preservar o buffer comum',
);

stage = 'suporte_coleta';
assert.equal(buffer.push('cliente-suporte', { text: 'Detalhe' }, { delayMs: 4500 }), 9000);

stage = 'plotagem_cidade';
assert.equal(buffer.push('cliente-cidade', { text: 'BH' }, { delayMs: 4500 }), 2500);

console.log('✅ Primeiro input aguarda 8s e renova a janela; demais buffers permanecem preservados.');