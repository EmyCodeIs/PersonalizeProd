'use strict';

const assert = require('assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'personalize-storage-maintenance-'));
process.chdir(tempRoot);
process.env.STORAGE_DRIVER = 'sqlite';
process.env.SQLITE_DATABASE_PATH = 'data/test.sqlite';
process.env.DATA_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
process.env.STORAGE_EVENT_PRUNE_ENABLED = 'true';
process.env.STORAGE_EVENT_MAX_PER_STREAM = '1000';
process.env.STORAGE_EVENT_PROTECTED_STREAMS = 'leads.jsonl';
process.env.STORAGE_EVENT_WARN_COUNT = '50000';
process.env.STORAGE_QUICK_CHECK_INTERVAL_HOURS = '1';

const Persistence = require('../src/services/persistence');
const Maintenance = require('../src/services/storageMaintenance');

try {
  const documentPath = path.join(tempRoot, 'data', 'sessions.json');
  const leadPath = path.join(tempRoot, 'data', 'leads.jsonl');
  const auditPath = path.join(tempRoot, 'data', 'runtime-audit.jsonl');

  Persistence.writeJson(documentPath, { sessions: { a: { etapa: 'inicio' } } });
  Persistence.appendJsonLine(leadPath, { id: 'lead-1', createdAt: new Date().toISOString() });
  Persistence.appendJsonLine(leadPath, { id: 'lead-2', createdAt: new Date().toISOString() });

  for (let index = 0; index < 1005; index += 1) {
    Persistence.appendJsonLine(auditPath, { index, createdAt: new Date().toISOString() });
  }

  const result = Maintenance.runStorageMaintenance({
    reason: 'teste',
    forceIntegrityCheck: true,
  });

  assert.equal(result.sqlite, true);
  assert.equal(result.integrity?.ok, true, `quick_check deve retornar ok: ${result.integrity?.messages}`);
  assert.equal(result.documents, 1);
  assert.equal(result.pruning?.removed, 5, 'somente excesso do stream técnico deve ser removido');
  assert.equal(Persistence.countJsonLines(auditPath), 1000);
  assert.equal(Persistence.countJsonLines(leadPath), 2, 'leads comerciais devem permanecer protegidos');
  assert.ok(Array.isArray(result.checkpoint));
  assert.ok(result.databaseBytes > 0);

  const snapshot = Maintenance.healthSnapshot();
  assert.equal(snapshot.events, 1002);
  assert.ok(snapshot.streams.some((item) => item.stream === 'leads.jsonl' && item.total === 2));
  assert.ok(snapshot.streams.some((item) => item.stream === 'runtime-audit.jsonl' && item.total === 1000));

  console.log('✅ SQLite saudável: quick_check, checkpoint, métricas e retenção protegida validados.');
} finally {
  Persistence.close();
  fs.rmSync(tempRoot, { recursive: true, force: true });
}