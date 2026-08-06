'use strict';

const assert = require('assert/strict');
const { resetRuntimeShutdownForTests, terminateFatal } = require('../src/core/runtimeShutdown');

(async () => {
  resetRuntimeShutdownForTests();
  const order = [];
  let exitCode = null;
  await terminateFatal(new Error('bootstrap falhou'), {
    logger: { error() { order.push('log'); }, warn() {} },
    stopAdminServer: async () => { order.push('close'); },
    exitProcess: (code) => { exitCode = code; order.push('exit'); },
  });
  assert.deepEqual(order, ['log', 'close', 'exit']);
  assert.equal(exitCode, 1);
  process.exitCode = 0;
  console.log('✅ Falha fatal fecha o servidor administrativo e encerra para o PM2 reiniciar.');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
