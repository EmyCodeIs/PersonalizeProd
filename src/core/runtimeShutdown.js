'use strict';

let terminating = false;

function timeout(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, Math.max(1, Number(ms || 1)));
    timer.unref?.();
  });
}

async function terminateFatal(error, options = {}) {
  if (terminating) return false;
  terminating = true;
  const logger = options.logger || console;
  const exitProcess = options.exitProcess || ((code) => process.exit(code));
  const stopAdminServer = options.stopAdminServer || (() => {
    const { stopQrAdminServer } = require('../services/qrAdminServer');
    return stopQrAdminServer();
  });

  logger.error('[PersonalizeWppConect] erro fatal:', error?.stack || error?.message || error);
  try {
    await Promise.race([Promise.resolve(stopAdminServer()), timeout(options.shutdownTimeoutMs || 3000)]);
  } catch (shutdownError) {
    logger.warn('[SISTEMA] falha ao fechar servidor administrativo:', shutdownError?.message || shutdownError);
  }

  process.exitCode = 1;
  exitProcess(1);
  return true;
}

function resetRuntimeShutdownForTests() {
  terminating = false;
}

module.exports = { resetRuntimeShutdownForTests, terminateFatal };
