'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');

const {
  SYSTEM_RESET_COMMAND,
  clearContact,
  isHistoricalCommand,
  isSystemResetCommand,
} = require('../src/core/systemReset');
const { BufferManager } = require('../src/core/bufferManager');
const { ChatTaskQueue } = require('../src/core/chatTaskQueue');
const { OutboundTracker } = require('../src/core/outboundTracker');

function source(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

async function testContactCleanup() {
  const notes = new Map([
    ['5531999999999@c.us', { content: 'Atendimento anterior' }],
  ]);
  const attached = new Map([
    ['5531999999999@c.us', new Set(['operacional', 'vendedor', 'manual'])],
  ]);
  const chats = new Map([
    ['5531999999999@c.us', { id: '5531999999999@c.us' }],
  ]);

  const windowMock = {
    WPP: {
      chat: {
        getNotes: async (chatId) => notes.get(chatId) || null,
        deleteNotes: async (chatId) => notes.delete(chatId),
        setNotes: async (chatId, content) => notes.set(chatId, { content }),
      },
      labels: {
        addOrRemoveLabels: async (chatIds, operations) => {
          for (const chatId of chatIds) {
            const labels = attached.get(chatId) || new Set();
            for (const operation of operations) {
              if (operation.type === 'remove') labels.delete(String(operation.labelId));
            }
            attached.set(chatId, labels);
          }
        },
      },
    },
    Store: {
      Chat: {
        get: (chatId) => chats.get(chatId) || null,
        find: async (chatId) => chats.get(chatId) || null,
      },
      Label: {
        getLabelsForModel: (chat) => (
          [...(attached.get(chat.id) || [])].map((id) => ({ id }))
        ),
      },
    },
  };

  const channel = {
    client: {
      page: {
        evaluate: async (fn, args) => {
          global.window = windowMock;
          try {
            return await fn(args);
          } finally {
            delete global.window;
          }
        },
      },
    },
  };

  const result = await clearContact(
    channel,
    '5531999999999@c.us',
    ['5531999999999@c.us'],
  );

  assert.equal(result.ok, true);
  assert.equal(result.note.cleared, true);
  assert.equal(notes.has('5531999999999@c.us'), false, 'a nota precisa ser excluída');
  assert.equal(result.labels.requested, 3);
  assert.equal(result.labels.removed, 3);
  assert.equal(result.labels.remaining, 0);
  assert.deepEqual(
    [...attached.get('5531999999999@c.us')],
    [],
    'o reset completo precisa remover etiquetas operacionais, de vendedor e manuais',
  );
}

async function testRuntimeBarriers() {
  const buffer = new BufferManager({ delayMs: 1000, onFlush: async () => {} });
  buffer.push('a@c.us', { text: 'um' });
  buffer.push('b@c.us', { text: 'dois' });
  assert.equal(buffer.clearAll(), 2);
  assert.equal(buffer.map.size, 0);

  const queue = new ChatTaskQueue({ maxUnits: 1, maxConcurrentChats: 1 });
  queue.pause();
  const first = queue.enqueue('a@c.us', async () => true).catch((error) => error.code);
  const second = queue.enqueue('b@c.us', async () => true).catch((error) => error.code);
  assert.equal(queue.cancelAllQueued('SYSTEM_RESET'), 2);
  assert.deepEqual(await Promise.all([first, second]), ['SYSTEM_RESET', 'SYSTEM_RESET']);
  assert.equal(await queue.waitForIdle({ timeoutMs: 20 }), true);
  queue.resume();

  const tracker = new OutboundTracker();
  tracker.register('a@c.us', { type: 'text', text: 'um' });
  tracker.register('b@c.us', { type: 'image' });
  assert.equal(tracker.clearAll(), 2);
  assert.equal(tracker.stats().pending, 0);
}

function testSingleOwnership() {
  const productionFiles = [
    'src/index.js',
    'src/bootstrap.js',
    'src/start-with-required-labels.js',
    'src/flow/customerFlow.js',
    'src/core/completedFlowSilencePreload.js',
    'src/core/supportAndServicesPreload.js',
    'src/core/runtimeReliabilityPreload.js',
    'src/core/idempotentServiceLabels.js',
    'src/core/resetCommandHandoffPreload.js',
    'src/core/systemReset.js',
  ];
  const literalOwners = productionFiles.filter((file) => source(file).includes("'/resetarsys'"));
  assert.deepEqual(literalOwners, ['src/core/systemReset.js']);

  assert.equal(
    source('src/core/systemReset.js').match(/Store\.resetSystem\(/g)?.length,
    1,
    'somente o núcleo central pode executar o reset global',
  );
  assert.doesNotMatch(source('src/flow/customerFlow.js'), /resetarsys|Store\.resetSystem\(/);
  assert.doesNotMatch(source('src/bootstrap.js'), /Sistema resetado para teste|installResetCleanup/);
  assert.doesNotMatch(
    source('src/start-with-required-labels.js'),
    /resetCleanupPreload|safeResetCleanupOverridePreload/,
  );

  assert.equal(
    fs.existsSync(path.join(__dirname, '..', 'src/core/resetCleanupPreload.js')),
    false,
  );
  assert.equal(
    fs.existsSync(path.join(__dirname, '..', 'src/core/safeResetCleanupOverridePreload.js')),
    false,
  );
}

async function run() {
  assert.equal(SYSTEM_RESET_COMMAND, '/resetarsys');
  assert.equal(isSystemResetCommand('/resetarsys'), true);
  assert.equal(isSystemResetCommand('/reset'), false);
  assert.equal(isHistoricalCommand({ source: 'history-recovery' }), true);
  assert.equal(isHistoricalCommand({ source: 'unread-bootstrap' }), true);
  assert.equal(isHistoricalCommand({ source: 'manual-test-command' }), false);
  assert.equal(
    isHistoricalCommand({
      source: 'manual-test-command',
      now: 200000,
      raw: { timestamp: 1 },
    }),
    true,
  );
  assert.equal(
    isHistoricalCommand({
      source: 'event',
      now: 200000,
      raw: { timestamp: 1 },
    }),
    true,
  );

  await testContactCleanup();
  await testRuntimeBarriers();
  testSingleOwnership();
  console.log('✅ /resetarsys verificado: núcleo único, histórico ignorado e limpeza completa confirmada.');
}

run().catch((error) => {
  console.error('❌ Teste do /resetarsys falhou:', error?.stack || error?.message || error);
  process.exitCode = 1;
});
