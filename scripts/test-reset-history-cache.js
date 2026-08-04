'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const originalCwd = process.cwd();
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'personalize-reset-history-'));
process.chdir(tempDir);
process.env.MOCK_MODE = 'true';
process.env.MAINTENANCE_INTERVAL_MS = '60000';
process.env.RUNTIME_CACHE_TTL_MS = '120000';

function message(id, timestamp, fromMe, body) {
  return {
    id: { _serialized: id },
    timestamp: Math.floor(new Date(timestamp).getTime() / 1000),
    fromMe,
    type: 'chat',
    body,
  };
}

async function main() {
  const ResetCheckpoint = require('../src/services/resetCheckpointStore');
  const Reliability = require('../src/core/runtimeReliabilityPreload');
  const clientId = '5531999999940@c.us';

  Reliability._test.writeHistoryGuardCache(clientId, {
    blocked: true,
    available: true,
    reason: 'manual_outbound_history',
    messageId: 'old-manual-message',
  });
  assert.equal(Reliability._test.readHistoryGuardCache(clientId).blocked, true);

  ResetCheckpoint.markReset(clientId, {
    at: '2026-08-04T14:00:00.000Z',
    messageId: 'reset-id',
    command: '/resetarsys',
    mode: 'TESTER_FULL',
  });

  assert.equal(
    Reliability._test.readHistoryGuardCache(clientId),
    null,
    'novo checkpoint precisa invalidar o cache de handoff histórico',
  );

  const history = [
    message('manual-before', '2026-08-04T13:50:00.000Z', true, 'mensagem antiga do vendedor'),
    message('reset-id', '2026-08-04T14:00:00.000Z', true, '/resetarsys'),
    message('customer-after', '2026-08-04T14:01:00.000Z', false, 'Olá novamente'),
  ];

  const afterReset = Reliability._test.findManualOutboundAfterCheckpoint(history, {
    at: '2026-08-04T14:00:00.000Z',
    messageId: 'reset-id',
    type: 'reset',
  });
  assert.equal(afterReset.found, false, 'saída anterior ao reset não pode recriar handoff');

  history.push(message('manual-after', '2026-08-04T14:02:00.000Z', true, 'agora assumi de novo'));
  const humanAfterReset = Reliability._test.findManualOutboundAfterCheckpoint(history, {
    at: '2026-08-04T14:00:00.000Z',
    messageId: 'reset-id',
    type: 'reset',
  });
  assert.equal(humanAfterReset.found, true, 'mensagem humana posterior ao reset precisa bloquear novamente');
  assert.equal(humanAfterReset.messageId, 'manual-after');

  console.log('✅ Histórico do reset verificado: cache antigo é invalidado e só saídas posteriores voltam a bloquear.');
}

main()
  .catch((error) => {
    console.error('❌ Teste do checkpoint histórico falhou:', error?.stack || error?.message || error);
    process.exitCode = 1;
  })
  .finally(() => {
    process.chdir(originalCwd);
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
  });
