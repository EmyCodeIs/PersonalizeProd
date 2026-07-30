'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const { fork } = require('node:child_process');

let child = null;
let stopping = false;
let restartTimer = null;

function enabled() {
  return !/^(0|false|no|nao|off)$/i.test(String(process.env.FISCAL_MODULE_ENABLED || 'true').trim());
}

function startFiscalModuleProcess() {
  if (!enabled()) {
    console.log('[FISCAL] módulo fiscal desativado por FISCAL_MODULE_ENABLED=false');
    return null;
  }
  if (child) return child;

  const secret = String(process.env.PANEL_INTERNAL_SECRET || crypto.randomBytes(32).toString('hex'));
  process.env.PANEL_INTERNAL_SECRET = secret;
  const entry = path.resolve(process.cwd(), 'src', 'modules', 'fiscal', 'index.js');
  const env = {
    ...process.env,
    PANEL_INTERNAL_SECRET: secret,
    FISCAL_INTERNAL_HOST: process.env.FISCAL_INTERNAL_HOST || '127.0.0.1',
    FISCAL_INTERNAL_PORT: process.env.FISCAL_INTERNAL_PORT || '3031',
    FISCAL_DATA_DIRECTORY: process.env.FISCAL_DATA_DIRECTORY || './data/fiscal',
    FISCAL_DOCUMENT_DIRECTORY: process.env.FISCAL_DOCUMENT_DIRECTORY || './storage/fiscal-documents',
  };

  child = fork(entry, [], { cwd: process.cwd(), env, stdio: 'inherit' });
  child.once('exit', (code, signal) => {
    child = null;
    if (stopping) return;
    console.warn(`[FISCAL] processo encerrado | código=${code ?? '-'} | sinal=${signal || '-'}`);
    restartTimer = setTimeout(() => {
      restartTimer = null;
      startFiscalModuleProcess();
    }, 5000);
    restartTimer.unref?.();
  });
  child.once('error', (error) => console.warn('[FISCAL] falha isolada:', error?.message || error));
  console.log(`[FISCAL] módulo iniciado internamente em http://${env.FISCAL_INTERNAL_HOST}:${env.FISCAL_INTERNAL_PORT}`);
  return child;
}

function stopFiscalModuleProcess() {
  stopping = true;
  if (restartTimer) clearTimeout(restartTimer);
  if (child && !child.killed) child.kill('SIGTERM');
}

process.once('SIGINT', stopFiscalModuleProcess);
process.once('SIGTERM', stopFiscalModuleProcess);

module.exports = { startFiscalModuleProcess, stopFiscalModuleProcess };
