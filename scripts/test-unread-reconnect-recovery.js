'use strict';

const assert = require('node:assert/strict');
const {
  createReconnectTracker,
  createRecoveryRunner,
  isConnectedState,
  isDisconnectedState,
} = require('../src/core/unreadReconnectRecovery');

assert.equal(isConnectedState('CONNECTED'), true);
assert.equal(isConnectedState('SYNCING'), false, 'SYNCING é transição e não pode liberar recuperação');
assert.equal(isConnectedState('RESUMING'), false, 'RESUMING é transição e não pode liberar recuperação');
assert.equal(isConnectedState('DISCONNECTED'), false);
assert.equal(isDisconnectedState('DISCONNECTED'), true);
assert.equal(isDisconnectedState('DISCONNECTEDMOBILE'), true);

const reconnections = [];
const track = createReconnectTracker((state) => reconnections.push(state));

track('CONNECTED');
track('DISCONNECTED');
assert.equal(track('SYNCING').reconnected, false);
assert.equal(track('RESUMING').reconnected, false);
assert.equal(track('CONNECTED').reconnected, true);
track('DISCONNECTEDMOBILE');
assert.equal(track('CONNECTED').reconnected, true);

assert.deepEqual(
  reconnections,
  ['CONNECTED', 'CONNECTED'],
  'a recuperação só pode ser disparada quando a conexão realmente voltar a CONNECTED',
);

(async () => {
  const delivered = [];
  let collections = 0;
  const recovery = createRecoveryRunner({
    collectUnreadMessages: async () => {
      collections += 1;
      return [{ from: 'cliente@c.us', text: 'Olá', raw: { id: 'msg-1' } }];
    },
    onMessage: async (item) => delivered.push(item),
    getClient: () => ({ connected: true }),
    delayMs: 5,
    logger: { log() {}, warn() {} },
  });

  recovery.schedule('reconexao-connected', 5);
  recovery.schedule('reconexao-connected', 5);
  await new Promise((resolve) => setTimeout(resolve, 40));

  assert.equal(collections, 1, 'debounce deve executar apenas uma varredura');
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].source, 'unread-reconexao-connected');
  recovery.dispose();

  console.log('✅ Reconexão protegida: SYNCING/RESUMING não liberam recuperação e o debounce evita varredura duplicada.');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
