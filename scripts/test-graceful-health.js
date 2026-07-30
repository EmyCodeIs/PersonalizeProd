'use strict';

const assert = require('assert/strict');
const http = require('http');

process.env.STORAGE_DRIVER = 'file';
process.env.GRACEFUL_SHUTDOWN_TIMEOUT_MS = '1500';
process.env.HEALTH_RSS_CRITICAL_MB = '4096';
process.env.HEALTH_QUEUE_CRITICAL_SIZE = '20';

const Lifecycle = require('../src/core/runtimeLifecycle');
const TesterRuntime = require('../src/core/testerRuntime');
const {
  closeQrAdminServer,
  startQrAdminServer,
} = require('../src/services/qrAdminServer');

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requestJson(port, path) {
  return new Promise((resolve, reject) => {
    const request = http.get({
      host: '127.0.0.1',
      port,
      path,
      agent: false,
      timeout: 2000,
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        try {
          resolve({
            statusCode: response.statusCode,
            body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
          });
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on('timeout', () => request.destroy(new Error('request_timeout')));
    request.on('error', reject);
  });
}

async function testHealthEndpoints() {
  Lifecycle._test.resetForTests();

  const server = startQrAdminServer({ host: '127.0.0.1', port: 0 });
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;

  const live = await requestJson(port, '/live');
  assert.equal(live.statusCode, 200);
  assert.equal(live.body.ok, true);
  assert.equal(live.body.phase, 'starting');

  const notReady = await requestJson(port, '/ready');
  assert.equal(notReady.statusCode, 503);
  assert.equal(notReady.body.ready, false);

  Lifecycle.registerChannel({ client: {} }, { mock: true });
  Lifecycle.markReady({ mock: true });

  const ready = await requestJson(port, '/ready');
  assert.equal(ready.statusCode, 200);
  assert.equal(ready.body.ready, true);
  assert.equal(ready.body.connected, true);
  assert.equal(ready.body.apiReady, true);

  const health = await requestJson(port, '/health');
  assert.equal(health.statusCode, 200);
  assert.equal(health.body.ok, true);
  assert.equal(health.body.checks.readiness, true);
  assert.equal(health.body.storage.driver, 'file');

  await closeQrAdminServer();
}

async function testGracefulDrain() {
  Lifecycle._test.resetForTests();
  const runtime = TesterRuntime._test.runtime;
  runtime.buffers.clear();
  runtime.queues.clear();

  let queueRunning = 0;
  let queueFinished = false;
  const queue = {
    queue: [],
    runningItems: new Map(),
    stats() {
      return {
        queued: 0,
        activeChats: queueRunning ? 1 : 0,
        runningTasks: queueRunning,
        timedOutTasks: 0,
      };
    },
    cancelQueuedForChats() { return 0; },
    cancelRunningForChats() { return 0; },
  };

  const buffer = {
    map: new Map([['chat-teste', { messages: [{ text: 'oi' }] }]]),
    stats() {
      return {
        activeChats: this.map.size,
        messages: this.map.size,
        bytes: this.map.size * 2,
      };
    },
    _flush(id) {
      if (!this.map.has(id)) return 0;
      this.map.delete(id);
      queueRunning = 1;
      setTimeout(() => {
        queueRunning = 0;
        queueFinished = true;
      }, 80).unref?.();
      return 1;
    },
  };

  runtime.buffers.add(buffer);
  runtime.queues.add(queue);

  let whatsappClosed = 0;
  let auxiliaryClosed = 0;
  Lifecycle.registerChannel({
    client: {
      async close() {
        whatsappClosed += 1;
      },
    },
  });
  Lifecycle.registerCloser('teste_auxiliar', async () => {
    auxiliaryClosed += 1;
  });
  Lifecycle.markReady();

  const before = await Lifecycle.healthSnapshot();
  assert.equal(before.ok, false, 'sem API do WhatsApp real, health deve recusar falso positivo');

  const result = await Lifecycle.gracefulShutdown({ signal: 'TEST', timeoutMs: 1200 });
  assert.equal(result.forced, false);
  assert.equal(result.flushedMessages, 1);
  assert.equal(queueFinished, true, 'o encerramento deve esperar a tarefa iniciada pelo buffer');
  assert.equal(whatsappClosed, 1, 'deve fechar o Chrome sem executar logout');
  assert.equal(auxiliaryClosed, 1);
  assert.equal(Lifecycle.isAcceptingMessages(), false);
  assert.equal(Lifecycle.snapshotState().phase, 'stopped');

  runtime.buffers.clear();
  runtime.queues.clear();
}

async function testLegacyImmediateExitIsRemoved() {
  Lifecycle._test.resetForTests();
  require('../src/core/gracefulHealthPreload');

  function legacyImmediateExit() {
    function stopWindowsSessionAccess() {}
    stopWindowsSessionAccess();
    process.exit(143);
  }

  process.once('SIGTERM', legacyImmediateExit);
  await Promise.resolve();
  assert.equal(
    process.listeners('SIGTERM').includes(legacyImmediateExit),
    false,
    'handler legado com process.exit imediato deve ser removido',
  );
}

(async () => {
  await testHealthEndpoints();
  await testGracefulDrain();
  await testLegacyImmediateExitIsRemoved();
  await wait(10);
  console.log('✅ Encerramento seguro e health real validados sem cortar fila, buffer ou sessão do WhatsApp.');
})().catch(async (error) => {
  try { await closeQrAdminServer(); } catch (_) {}
  console.error(error);
  process.exitCode = 1;
});
