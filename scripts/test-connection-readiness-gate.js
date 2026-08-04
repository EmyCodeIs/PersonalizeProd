'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const originalCwd = process.cwd();
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'personalize-connection-gate-'));
process.chdir(tempDir);
process.env.STORAGE_DRIVER = 'file';
process.env.MESSAGE_INBOX_ENABLED = 'true';
process.env.CONNECTION_DEFER_RETRY_MS = '500';

async function run() {
  const modulePaths = [
    '../src/core/connectionReadinessGatePreload',
    '../src/services/messageInboxStore',
    '../src/services/connectionSupervisor',
    '../src/services/persistence',
    '../src/config/connectionConfig',
  ];
  for (const modulePath of modulePaths) delete require.cache[require.resolve(modulePath)];

  const Inbox = require('../src/services/messageInboxStore');
  const {
    ConnectionSupervisor,
    setActiveConnectionSupervisor,
  } = require('../src/services/connectionSupervisor');
  const { deferInboxMessage } = require('../src/core/connectionReadinessGatePreload');

  const supervisor = new ConnectionSupervisor({
    config: {
      syncTimeoutMs: 60000,
      recoveryDelayMs: 60000,
      recoveryCooldownMs: 60000,
      maxRecoveryAttempts: 3,
      exitOnFailure: false,
    },
    logger: { log() {}, warn() {}, error() {} },
  });
  supervisor.beginGeneration('gate-test');
  supervisor.observeState('SYNCING', { source: 'test' });
  setActiveConnectionSupervisor(supervisor);

  const record = Inbox.receive({
    from: '5531999999701@c.us',
    text: 'Mensagem durante sincronização',
    source: 'event',
    raw: {
      id: { _serialized: 'connection-gate-message-1' },
      from: '5531999999701@c.us',
      body: 'Mensagem durante sincronização',
      type: 'chat',
    },
  }).record;

  const deferred = deferInboxMessage({
    from: record.conversationId,
    text: record.text,
    __personalizeInboxId: record.id,
    raw: { __personalizeInboxId: record.id },
  }, supervisor);

  assert.equal(deferred, true);
  const waiting = Inbox.readRecord(record.id);
  assert.equal(waiting.status, Inbox.STATUS.FAILED_RETRYABLE);
  assert.equal(waiting.attempts, 0, 'esperar READY não pode consumir tentativa do fluxo');
  assert.equal(waiting.lastError.code, 'CONNECTION_NOT_READY');

  Inbox.transition([record.id], Inbox.STATUS.FAILED_RETRYABLE, {
    reason: 'release-test',
    patch: { availableAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() },
  });

  const blockedLookup = Inbox.listRecoverable({ staleMs: 0, limit: 10 });
  assert.equal(blockedLookup.length, 0, 'Inbox não pode recuperar enquanto SYNCING');

  supervisor.observeState('CONNECTED', { source: 'test' });
  const readyLookup = Inbox.listRecoverable({ staleMs: 0, limit: 10 });
  assert.equal(readyLookup.length, 1, 'registro deve ser liberado quando a conexão fica READY');
  assert.equal(readyLookup[0].id, record.id);

  setActiveConnectionSupervisor(null);
  console.log('✅ Gate de conexão: mensagem persiste, não consome tentativa e só recupera em READY.');
}

run()
  .catch((error) => {
    console.error('❌ Teste do gate de conexão falhou:', error?.stack || error?.message || error);
    process.exitCode = 1;
  })
  .finally(() => {
    process.chdir(originalCwd);
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
  });
