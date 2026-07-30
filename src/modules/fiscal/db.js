'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { hashPassword } = require('./auth');

function isoNow() { return new Date().toISOString(); }

function ensureColumn(db, table, definition) {
  const name = definition.trim().split(/\s+/)[0];
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((column) => column.name === name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
}

function dpsSequenceName(config) {
  return `dps:${config.runtimeMode}:${config.focus.environment}:${config.dpsSeries}`;
}

function invoicesTableSql(table = 'invoices') {
  return `CREATE TABLE ${table} (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_user_id INTEGER NOT NULL REFERENCES users(id),
    draft_id INTEGER REFERENCES drafts(id),
    focus_reference TEXT NOT NULL UNIQUE,
    dps_series INTEGER NOT NULL,
    dps_number INTEGER NOT NULL,
    nfse_number TEXT,
    status TEXT NOT NULL,
    client_name TEXT NOT NULL,
    client_document TEXT NOT NULL,
    service_profile_id TEXT NOT NULL REFERENCES service_profiles(id),
    service_description TEXT NOT NULL,
    service_amount REAL NOT NULL,
    payload_json TEXT NOT NULL,
    focus_response_json TEXT,
    error_message TEXT,
    pdf_path TEXT,
    xml_path TEXT,
    issued_at TEXT,
    authorized_at TEXT,
    cancelled_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    environment TEXT NOT NULL DEFAULT 'legacy',
    runtime_mode TEXT NOT NULL DEFAULT 'legacy',
    fiscal_key TEXT,
    verification_code TEXT,
    pdf_remote TEXT,
    xml_remote TEXT,
    last_checked_at TEXT,
    consultation_count INTEGER NOT NULL DEFAULT 0,
    document_error TEXT,
    UNIQUE(environment, runtime_mode, dps_series, dps_number)
  )`;
}

function invoiceEventsTableSql(table = 'invoice_events') {
  return `CREATE TABLE ${table} (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    message TEXT NOT NULL,
    metadata_json TEXT,
    created_at TEXT NOT NULL
  )`;
}

function migrateInvoiceSequenceConstraint(db) {
  const schema = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='invoices'").get()?.sql || '';
  const normalized = schema.replace(/\s+/g, '').toLowerCase();
  const legacyUnique = normalized.includes('unique(dps_series,dps_number)');
  const scopedUnique = normalized.includes('unique(environment,runtime_mode,dps_series,dps_number)');
  if (!legacyUnique || scopedUnique) return;

  db.exec('PRAGMA foreign_keys=OFF;');
  try {
    db.exec('BEGIN IMMEDIATE;');
    db.exec('ALTER TABLE invoice_events RENAME TO invoice_events_legacy;');
    db.exec('ALTER TABLE invoices RENAME TO invoices_legacy;');
    db.exec(invoicesTableSql());
    db.exec(`INSERT INTO invoices(
      id,owner_user_id,draft_id,focus_reference,dps_series,dps_number,nfse_number,status,client_name,client_document,
      service_profile_id,service_description,service_amount,payload_json,focus_response_json,error_message,pdf_path,xml_path,
      issued_at,authorized_at,cancelled_at,created_at,updated_at,environment,runtime_mode,fiscal_key,verification_code,
      pdf_remote,xml_remote,last_checked_at,consultation_count,document_error
    ) SELECT
      id,owner_user_id,draft_id,focus_reference,dps_series,dps_number,nfse_number,status,client_name,client_document,
      service_profile_id,service_description,service_amount,payload_json,focus_response_json,error_message,pdf_path,xml_path,
      issued_at,authorized_at,cancelled_at,created_at,updated_at,environment,runtime_mode,fiscal_key,verification_code,
      pdf_remote,xml_remote,last_checked_at,consultation_count,document_error
    FROM invoices_legacy;`);
    db.exec(invoiceEventsTableSql());
    db.exec(`INSERT INTO invoice_events(id,invoice_id,type,message,metadata_json,created_at)
      SELECT id,invoice_id,type,message,metadata_json,created_at FROM invoice_events_legacy;`);
    db.exec('DROP TABLE invoice_events_legacy; DROP TABLE invoices_legacy; COMMIT;');
  } catch (error) {
    try { db.exec('ROLLBACK;'); } catch {}
    throw error;
  } finally {
    db.exec('PRAGMA foreign_keys=ON;');
  }
}

function createDatabase(config) {
  fs.mkdirSync(config.dataDirectory, { recursive: true });
  const dbPath = path.join(config.dataDirectory, 'personalize-nf.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin','seller')) DEFAULT 'seller',
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token_hash TEXT NOT NULL UNIQUE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS service_profiles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description_template TEXT NOT NULL,
      national_tax_code TEXT NOT NULL,
      municipal_tax_code TEXT NOT NULL,
      nbs_code TEXT,
      ibs_cbs_tax_status TEXT,
      ibs_cbs_tax_classification TEXT,
      iss_taxation INTEGER NOT NULL DEFAULT 1,
      iss_retention_type INTEGER NOT NULL DEFAULT 1,
      pis_cofins_status TEXT NOT NULL DEFAULT '00',
      approximate_tax_percent REAL NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS drafts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_user_id INTEGER NOT NULL REFERENCES users(id),
      status TEXT NOT NULL DEFAULT 'draft',
      data_json TEXT NOT NULL,
      invoice_id INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    ${invoicesTableSql().replace('CREATE TABLE invoices', 'CREATE TABLE IF NOT EXISTS invoices')};
    ${invoiceEventsTableSql().replace('CREATE TABLE invoice_events', 'CREATE TABLE IF NOT EXISTS invoice_events')};
    CREATE TABLE IF NOT EXISTS sequences (
      name TEXT PRIMARY KEY,
      value INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER REFERENCES users(id),
      action TEXT NOT NULL,
      entity_type TEXT,
      entity_id TEXT,
      metadata_json TEXT,
      created_at TEXT NOT NULL
    );
  `);

  ensureColumn(db, 'service_profiles', 'nbs_code TEXT');
  ensureColumn(db, 'service_profiles', 'ibs_cbs_tax_status TEXT');
  ensureColumn(db, 'service_profiles', 'ibs_cbs_tax_classification TEXT');
  ensureColumn(db, 'invoices', "environment TEXT NOT NULL DEFAULT 'legacy'");
  ensureColumn(db, 'invoices', "runtime_mode TEXT NOT NULL DEFAULT 'legacy'");
  ensureColumn(db, 'invoices', 'fiscal_key TEXT');
  ensureColumn(db, 'invoices', 'verification_code TEXT');
  ensureColumn(db, 'invoices', 'pdf_remote TEXT');
  ensureColumn(db, 'invoices', 'xml_remote TEXT');
  ensureColumn(db, 'invoices', 'last_checked_at TEXT');
  ensureColumn(db, 'invoices', 'consultation_count INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'invoices', 'document_error TEXT');
  migrateInvoiceSequenceConstraint(db);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);
    CREATE INDEX IF NOT EXISTS idx_invoices_environment ON invoices(environment, runtime_mode);
    CREATE INDEX IF NOT EXISTS idx_invoices_fiscal_key ON invoices(fiscal_key);
  `);

  const now = isoNow();
  const user = db.prepare('SELECT id FROM users WHERE email = ?').get(config.admin.email);
  if (!user) {
    db.prepare(`INSERT INTO users(name,email,password_hash,role,active,created_at,updated_at)
      VALUES(?,?,?,?,1,?,?)`).run(config.admin.name, config.admin.email, hashPassword(config.admin.password), 'admin', now, now);
  }

  const services = [
    {
      id: 'plotagem', name: 'Serviços de plotagem', template: 'Serviços de plotagem',
      national: '130501', municipal: '005', nbs: config.services.plotagem.nbsCode || null,
      ibsCbsTaxStatus: config.services.plotagem.ibsCbsTaxStatus || null,
      ibsCbsTaxClassification: config.services.plotagem.ibsCbsTaxClassification || null,
    },
    {
      id: 'producao-comunicacao-visual', name: 'Produção de letreiro ou adesivo', template: 'Produção de letreiro personalizado',
      national: '240102', municipal: '001', nbs: config.services.producaoComunicacaoVisual.nbsCode || null,
      ibsCbsTaxStatus: config.services.producaoComunicacaoVisual.ibsCbsTaxStatus || null,
      ibsCbsTaxClassification: config.services.producaoComunicacaoVisual.ibsCbsTaxClassification || null,
    },
  ];
  const upsertService = db.prepare(`INSERT INTO service_profiles(
    id,name,description_template,national_tax_code,municipal_tax_code,nbs_code,ibs_cbs_tax_status,ibs_cbs_tax_classification,
    iss_taxation,iss_retention_type,pis_cofins_status,approximate_tax_percent,active,created_at,updated_at
  ) VALUES(?,?,?,?,?,?,?,?,1,1,'00',?,1,?,?)
  ON CONFLICT(id) DO UPDATE SET name=excluded.name, description_template=excluded.description_template,
    national_tax_code=excluded.national_tax_code, municipal_tax_code=excluded.municipal_tax_code,
    nbs_code=excluded.nbs_code, ibs_cbs_tax_status=excluded.ibs_cbs_tax_status,
    ibs_cbs_tax_classification=excluded.ibs_cbs_tax_classification,
    approximate_tax_percent=excluded.approximate_tax_percent, updated_at=excluded.updated_at`);
  for (const service of services) {
    upsertService.run(
      service.id, service.name, service.template, service.national, service.municipal, service.nbs,
      service.ibsCbsTaxStatus, service.ibsCbsTaxClassification,
      config.company.approximateTaxPercent, now, now,
    );
  }

  const sequenceName = dpsSequenceName(config);
  const maximum = Number(db.prepare(`SELECT COALESCE(MAX(dps_number),0) value FROM invoices
    WHERE dps_series=? AND environment=? AND runtime_mode=?`)
    .get(config.dpsSeries, config.focus.environment, config.runtimeMode)?.value || 0);
  db.prepare('INSERT INTO sequences(name,value,updated_at) VALUES(?,?,?) ON CONFLICT(name) DO NOTHING')
    .run(sequenceName, maximum, now);
  const current = Number(db.prepare('SELECT value FROM sequences WHERE name=?').get(sequenceName)?.value || 0);
  if (current < maximum) db.prepare('UPDATE sequences SET value=?,updated_at=? WHERE name=?').run(maximum, now, sequenceName);
  return db;
}

function nextDpsNumber(db, config) {
  const name = dpsSequenceName(config);
  db.exec('BEGIN IMMEDIATE');
  try {
    const maximum = Number(db.prepare(`SELECT COALESCE(MAX(dps_number),0) value FROM invoices
      WHERE dps_series=? AND environment=? AND runtime_mode=?`)
      .get(config.dpsSeries, config.focus.environment, config.runtimeMode)?.value || 0);
    const row = db.prepare('SELECT value FROM sequences WHERE name=?').get(name);
    if (!row) db.prepare('INSERT INTO sequences(name,value,updated_at) VALUES(?,?,?)').run(name, maximum, isoNow());
    const current = Number(db.prepare('SELECT value FROM sequences WHERE name=?').get(name)?.value || 0);
    const value = Math.max(current, maximum) + 1;
    db.prepare('UPDATE sequences SET value=?,updated_at=? WHERE name=?').run(value, isoNow(), name);
    db.exec('COMMIT');
    return value;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function addEvent(db, invoiceId, type, message, metadata = null) {
  db.prepare('INSERT INTO invoice_events(invoice_id,type,message,metadata_json,created_at) VALUES(?,?,?,?,?)')
    .run(invoiceId, type, message, metadata ? JSON.stringify(metadata) : null, isoNow());
}

function addAudit(db, userId, action, entityType = null, entityId = null, metadata = null) {
  db.prepare('INSERT INTO audit_logs(user_id,action,entity_type,entity_id,metadata_json,created_at) VALUES(?,?,?,?,?,?)')
    .run(userId || null, action, entityType, entityId == null ? null : String(entityId), metadata ? JSON.stringify(metadata) : null, isoNow());
}

module.exports = { createDatabase, nextDpsNumber, dpsSequenceName, addEvent, addAudit, isoNow };
