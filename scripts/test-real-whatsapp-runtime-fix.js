'use strict';

const assert = require('assert/strict');

require('../src/core/realWhatsAppRuntimeFixPreload');

const Fix = require('../src/core/realWhatsAppRuntimeFixPreload');
const {
  ConnectionSupervisor,
  STATES,
} = require('../src/services/connectionSupervisor');

const logger = { log() {}, warn() {}, error() {} };
const config = {
  probeTimeoutMs: 1000,
  syncTimeoutMs: 2000,
  recoveryDelayMs: 50,
  recoveryCooldownMs: 50,
  recoveryActionTimeoutMs: 500,
  maxRecoveryAttempts: 3,
  exitOnFailure: false,
  exitDelayMs: 50,
};

function fakeClient(pageTruth) {
  const listeners = [];
  return {
    onStateChange(callback) { listeners.push(callback); },
    async getConnectionState() { return 'INCHAT'; },
    page: {
      async evaluate() { return pageTruth; },
    },
    emit(state) {
      for (const listener of listeners) listener(state);
    },
  };
}

async function testStrictReady() {
  let supervisor = new ConnectionSupervisor({ config, logger });
  let generation = supervisor.beginGeneration('unpaired_test');
  let client = fakeClient({
    authenticated: false,
    mainReady: false,
    fullReady: false,
    streamMode: null,
    streamInfo: null,
  });

  supervisor.attachClient(client, generation);
  client.emit('INCHAT');
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(supervisor.isReady(), false, 'INCHAT sem autenticação não pode liberar atendimento');
  assert.equal(supervisor.state, STATES.WAITING_QR);
  supervisor.dispose();

  supervisor = new ConnectionSupervisor({ config, logger });
  generation = supervisor.beginGeneration('ready_test');
  client = fakeClient({
    authenticated: true,
    mainReady: true,
    fullReady: true,
    streamMode: 'MAIN',
    streamInfo: 'NORMAL',
  });

  supervisor.attachClient(client, generation);
  client.emit('INCHAT');
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(supervisor.isReady(), true, 'autenticação e estado principal devem liberar READY');
  assert.equal(supervisor.state, STATES.READY);
  supervisor.dispose();
}

async function testCrmLabels() {
  const labels = [];
  let createCalls = 0;
  let applyCalls = 0;

  global.window = {
    WPP: {
      labels: {
        async getAllLabels() { return labels; },
        async addNewLabel(name, options) {
          createCalls += 1;
          const item = { id: String(labels.length + 1), name, options };
          labels.push(item);
          return item;
        },
        async addOrRemoveLabels() {
          applyCalls += 1;
          return true;
        },
      },
    },
  };

  const channel = {
    client: {
      page: {
        async evaluate(callback, args) { return callback(args); },
      },
    },
  };

  await Fix.initializeLabels(channel);
  const firstPass = createCalls;
  await Fix.initializeLabels(channel);

  assert(firstPass > 0, 'as etiquetas obrigatórias devem ser conferidas');
  assert.equal(createCalls, firstPass, 'a inicialização não pode repetir criações');

  const applied = await Fix.applyLabel(
    channel,
    '5531999999999@c.us',
    { name: 'Orçamento letreiros', color: 'green' },
  );
  assert.equal(applied?.applied, true);
  assert.equal(applyCalls, 1);

  delete global.window;
}

(async () => {
  await testStrictReady();
  await testCrmLabels();
  console.log('✅ Runtime real: QR/READY estritos e etiquetas CRM verificados.');
})().catch((error) => {
  console.error('❌ Runtime real:', error?.stack || error?.message || error);
  process.exitCode = 1;
});
