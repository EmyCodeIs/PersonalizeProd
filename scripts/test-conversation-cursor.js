'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const originalCwd = process.cwd();
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'personalize-cursor-'));
process.chdir(tempDir);
process.env.STORAGE_DRIVER = 'file';
process.env.CONVERSATION_RECOVERY_MAX_AGE_HOURS = '48';

function clearModules() {
  for (const modulePath of [
    '../src/services/conversationCursorStore',
    '../src/services/resetCheckpointStore',
    '../src/services/contactIdentity',
    '../src/services/persistence',
    '../src/config/recoveryConfig',
    '../src/config/env',
  ]) {
    delete require.cache[require.resolve(modulePath)];
  }
}

try {
  clearModules();
  const Identity = require('../src/services/contactIdentity');
  const ResetCheckpoint = require('../src/services/resetCheckpointStore');
  let Cursor = require('../src/services/conversationCursorStore');

  const lid = '123456789@lid';
  const cUsId = '5531999999701@c.us';
  Identity.registerContact({ chatId: lid, phone: '5531999999701' });

  const base = Date.now() - 3600000;
  Cursor.ensureBaseline(lid, {
    at: base,
    source: 'session_state',
    session: { etapa: 'cidade', dados: { flow: 'letreiro', nome: 'Cliente Teste' } },
  });

  assert.equal(Cursor.getCursor(cUsId).conversationKey, Cursor.getCursor(lid).conversationKey, 'aliases devem compartilhar cursor');
  assert.equal(
    Cursor.shouldRecover(cUsId, { messageId: 'm-grace', sourceTimestamp: base + 1000 }, { graceMs: 1500 }).recover,
    false,
    'baseline deve respeitar a margem de segurança',
  );
  assert.equal(
    Cursor.shouldRecover(cUsId, { messageId: 'm-new', sourceTimestamp: base + 2500 }, { graceMs: 1500 }).recover,
    true,
  );

  Cursor.observeReceived(cUsId, { messageId: 'm-received', sourceTimestamp: base + 2800 });
  assert.equal(Cursor.getCursor(lid).lifecycle, 'ACTIVE');
  assert.equal(Cursor.getCursor(lid).lastCustomerMessageAt, new Date(base + 2800).toISOString());

  Cursor.markProcessed(lid, { messageId: 'm-processed', sourceTimestamp: base + 3000 }, {
    session: { etapa: 'endereco', dados: { flow: 'letreiro', nome: 'Cliente Teste' } },
  });
  assert.equal(Cursor.shouldRecover(cUsId, { messageId: 'm-processed', sourceTimestamp: base + 3000 }).reason, 'ALREADY_PROCESSED_ID');
  assert.equal(Cursor.shouldRecover(cUsId, { messageId: 'm-older', sourceTimestamp: base + 2000 }).reason, 'BEFORE_CURSOR');
  assert.equal(Cursor.shouldRecover(cUsId, { messageId: 'm-later', sourceTimestamp: base + 3500 }).recover, true);

  const abandoned = Cursor.markLifecycle(cUsId, 'ABANDONED_24H', { reason: 'customer_inactive_24h', now: base + 4000 });
  const sameAbandoned = Cursor.markLifecycle(lid, 'ABANDONED_24H', { reason: 'customer_inactive_24h', now: base + 8000 });
  assert.equal(sameAbandoned.lifecycleAt, abandoned.lifecycleAt, 'monitor não pode renovar artificialmente a data do mesmo estado');

  const resetAt = new Date(base + 5000).toISOString();
  ResetCheckpoint.markReset(cUsId, { at: resetAt, generation: 9, messageId: 'reset-9' });
  assert.equal(Cursor.shouldRecover(lid, { messageId: 'm-before-reset', sourceTimestamp: base + 4500 }).reason, 'BEFORE_RESET');
  assert.equal(Cursor.shouldRecover(lid, { messageId: 'm-after-reset', sourceTimestamp: base + 6000 }).recover, true);

  Cursor.markReset(lid, { at: resetAt, generation: 9, messageId: 'reset-9' });
  assert.equal(Cursor.getCursor(cUsId).lifecycle, 'RESET');
  assert.equal(Cursor.getCursor(cUsId).lastProcessedAt, null);

  clearModules();
  Cursor = require('../src/services/conversationCursorStore');
  assert.equal(Cursor.getCursor(cUsId).resetGeneration, 9, 'cursor precisa sobreviver ao reinício');
  assert.equal(Cursor.stats().total, 1, 'aliases não podem duplicar a contagem de conversas');

  console.log('✅ Cursor persistente: aliases, baseline, ordenação, processamento, reset e reinício verificados.');
} finally {
  process.chdir(originalCwd);
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
}
