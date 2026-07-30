'use strict';

const assert = require('assert/strict');
const { BufferManager } = require('../src/core/bufferManager');
const { ChatTaskQueue } = require('../src/core/chatTaskQueue');

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function testBufferLimits() {
  const batches = [];
  const buffer = new BufferManager({
    delayMs: 10000,
    maxMessagesPerChat: 2,
    maxBytesPerChat: 64,
    maxActiveChats: 2,
    onFlush: async (chatId, messages) => {
      batches.push({ chatId, messages: messages.map((item) => item.text) });
    },
  });

  buffer.push('chat-a', { text: 'primeira' });
  buffer.push('chat-a', { text: 'segunda' });
  buffer.push('chat-a', { text: 'terceira' });
  await wait(5);

  assert.deepEqual(batches[0], {
    chatId: 'chat-a',
    messages: ['primeira', 'segunda'],
  }, 'ao alcançar o limite, deve processar o lote anterior sem descartar conteúdo');
  assert.equal(buffer.stats().messages, 1, 'a mensagem seguinte deve permanecer no novo lote');

  buffer.push('chat-b', { text: 'b' });
  buffer.push('chat-c', { text: 'c' });
  await wait(5);
  assert.ok(
    batches.some((item) => item.chatId === 'chat-a' && item.messages.includes('terceira')),
    'ao atingir o limite global, o buffer mais antigo deve ser processado, não apagado',
  );
  assert.equal(buffer.stats().activeChats, 2);

  const largeText = 'x'.repeat(200);
  buffer.push('chat-large', { text: largeText });
  await wait(5);
  assert.ok(
    batches.some((item) => item.chatId === 'chat-large' && item.messages[0] === largeText),
    'mensagem grande deve ser processada inteira e imediatamente',
  );

  buffer.clearAll();
}

async function testQueueTimeoutIsolation() {
  const queue = new ChatTaskQueue({
    maxUnits: 1,
    maxConcurrentChats: 2,
    maxQueueSize: 10,
    taskTimeoutMs: 30,
  });

  let finishSlowTask;
  let receivedSignal = null;
  let sameChatStarted = false;
  const slow = queue.enqueue('chat-lento', ({ signal }) => {
    receivedSignal = signal;
    return new Promise((resolve) => { finishSlowTask = resolve; });
  });

  const sameChat = queue.enqueue('chat-lento', async () => {
    sameChatStarted = true;
    return 'preservado';
  });
  const otherChat = queue.enqueue('chat-livre', async () => 'processado');

  await assert.rejects(slow, (error) => error?.code === 'QUEUE_TIMEOUT');
  assert.equal(receivedSignal?.aborted, true, 'timeout deve sinalizar cancelamento cooperativo');
  assert.equal(await otherChat, 'processado', 'outros clientes devem continuar após o timeout');
  assert.equal(sameChatStarted, false, 'a próxima tarefa do mesmo chat não pode concorrer com a tarefa lenta');

  const duringTimeout = queue.stats();
  assert.equal(duringTimeout.runningUnits, 0, 'capacidade global deve ser liberada');
  assert.equal(duringTimeout.activeChats, 1, 'o chat lento deve continuar bloqueado até a tarefa real terminar');
  assert.equal(duringTimeout.timedOutTasks, 1);
  assert.equal(duringTimeout.queued, 1, 'a próxima mensagem do chat deve permanecer aguardando');

  finishSlowTask('finalizada tarde');
  assert.equal(await sameChat, 'preservado', 'a próxima tarefa deve executar após a liberação real do chat');
  await wait(5);
  const afterFinish = queue.stats();
  assert.equal(afterFinish.activeChats, 0);
  assert.equal(afterFinish.runningTasks, 0);
  assert.equal(afterFinish.queued, 0);
}

(async () => {
  await testBufferLimits();
  await testQueueTimeoutIsolation();
  console.log('✅ Runtime protegido: buffers sem perda e timeout isolado preservando a próxima mensagem.');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});