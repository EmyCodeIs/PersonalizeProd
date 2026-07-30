'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { URL } = require('node:url');
const { verifyPassword, randomToken, sessionDigest, parseCookies } = require('./auth');
const { nextDpsNumber, addEvent, addAudit, isoNow } = require('./db');
const { validateDraft, buildPayload, digits } = require('./payloadBuilder');
const {
  mapStatus,
  extractErrorMessage,
  extractFiscalMetadata,
  extractDocumentLinks,
} = require('./focusClient');
const { writeDemoDocuments } = require('./demoDocuments');

function sendJson(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 2_000_000) reject(Object.assign(new Error('Corpo muito grande.'), { status: 413 }));
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try { resolve(JSON.parse(body)); } catch { reject(Object.assign(new Error('JSON inválido.'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

function parseJson(value, fallback = {}) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function publicUser(user) {
  return user ? { id: user.id, name: user.name, email: user.email, role: user.role } : null;
}

function createReference() {
  return `PNF${new Date().toISOString().slice(0, 10).replace(/-/g, '')}${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
}

function safeSecretEquals(received, expected) {
  const left = Buffer.from(String(received || ''));
  const right = Buffer.from(String(expected || ''));
  return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right);
}

function webhookReference(payload = {}) {
  return String(
    payload.ref || payload.referencia || payload.reference ||
    payload.data?.ref || payload.data?.referencia || payload.documento?.ref || '',
  ).trim();
}

function createServer({ config, db, focus }) {
  const cookieName = 'personalize_nf_session';

  function authenticate(req) {
    const trustedSecret = req.headers['x-personalize-panel-secret'];
    if (config.panelTrustSecret && safeSecretEquals(trustedSecret, config.panelTrustSecret)) {
      const trustedUser = db.prepare('SELECT id,name,email,role,active FROM users WHERE email=? AND active=1 LIMIT 1').get(config.admin.email);
      if (trustedUser) return trustedUser;
    }

    const token = parseCookies(req.headers.cookie || '')[cookieName];
    if (!token) return null;
    const row = db.prepare(`SELECT u.id,u.name,u.email,u.role,u.active,s.expires_at
      FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?`).get(sessionDigest(token, config.sessionSecret));
    if (!row || !row.active || new Date(row.expires_at).getTime() <= Date.now()) return null;
    return row;
  }

  function requireUser(req, res) {
    const user = authenticate(req);
    if (!user) sendJson(res, 401, { error: 'Faça login para continuar.' });
    return user;
  }

  function canAccess(user, record) {
    return user.role === 'admin' || Number(record.owner_user_id) === Number(user.id);
  }

  function getInvoice(id) {
    return db.prepare(`SELECT i.*,u.name owner_name,s.name service_name FROM invoices i
      JOIN users u ON u.id=i.owner_user_id JOIN service_profiles s ON s.id=i.service_profile_id WHERE i.id=?`).get(id);
  }

  function getInvoiceByReference(reference) {
    return db.prepare(`SELECT i.*,u.name owner_name,s.name service_name FROM invoices i
      JOIN users u ON u.id=i.owner_user_id JOIN service_profiles s ON s.id=i.service_profile_id WHERE i.focus_reference=?`).get(reference);
  }

  function events(invoiceId) {
    return db.prepare('SELECT id,type,message,metadata_json,created_at FROM invoice_events WHERE invoice_id=? ORDER BY id').all(invoiceId)
      .map((event) => ({ ...event, metadata: parseJson(event.metadata_json, null) }));
  }

  function localDocumentExists(filePath) {
    return Boolean(filePath && fs.existsSync(filePath) && fs.statSync(filePath).isFile());
  }

  function invoiceDto(invoice) {
    if (!invoice) return null;
    const hasPdf = localDocumentExists(invoice.pdf_path);
    const hasXml = localDocumentExists(invoice.xml_path);
    return {
      ...invoice,
      payload: parseJson(invoice.payload_json),
      focusResponse: parseJson(invoice.focus_response_json, null),
      events: events(invoice.id),
      hasPdf,
      hasXml,
      documentsPending: invoice.status === 'authorized' && (!hasPdf || !hasXml),
    };
  }

  function documentTarget(invoice, kind) {
    const folder = path.join(config.documentDirectory, invoice.focus_reference);
    const filename = kind === 'pdf' ? 'danfse.pdf' : 'nfse.xml';
    return path.join(folder, filename);
  }

  async function cacheDocuments(invoice, response) {
    if (config.demoMode) {
      const number = invoice.nfse_number || `D${String(invoice.id).padStart(6, '0')}`;
      const docs = writeDemoDocuments(config, { ...invoice, nfse_number: number });
      return {
        pdfPath: docs.pdfPath,
        xmlPath: docs.xmlPath,
        pdfRemote: null,
        xmlRemote: null,
        documentError: null,
      };
    }

    const links = extractDocumentLinks(response);
    const pdfRemote = links.pdf || invoice.pdf_remote || null;
    const xmlRemote = links.xml || invoice.xml_remote || null;
    let pdfPath = localDocumentExists(invoice.pdf_path) ? invoice.pdf_path : null;
    let xmlPath = localDocumentExists(invoice.xml_path) ? invoice.xml_path : null;
    const failures = [];

    if (!pdfPath && pdfRemote) {
      try { pdfPath = await focus.download(pdfRemote, documentTarget(invoice, 'pdf')); }
      catch (error) { failures.push(`PDF: ${error.message}`); }
    }
    if (!xmlPath && xmlRemote) {
      try { xmlPath = await focus.download(xmlRemote, documentTarget(invoice, 'xml')); }
      catch (error) { failures.push(`XML: ${error.message}`); }
    }

    return {
      pdfPath,
      xmlPath,
      pdfRemote,
      xmlRemote,
      documentError: failures.length ? failures.join(' | ') : null,
    };
  }

  async function applyFocusResponse(invoice, response, source = 'consulta') {
    const status = mapStatus(response);
    const now = isoNow();
    const previousStatus = invoice.status;

    if (status === 'authorized') {
      const metadata = extractFiscalMetadata(response);
      const number = metadata.number ? String(metadata.number) : (invoice.nfse_number || (config.demoMode ? `D${String(invoice.id).padStart(6, '0')}` : null));
      const baseInvoice = { ...invoice, nfse_number: number };
      const documents = await cacheDocuments(baseInvoice, response);
      db.prepare(`UPDATE invoices SET status='authorized',nfse_number=?,fiscal_key=?,verification_code=?,focus_response_json=?,
        pdf_path=?,xml_path=?,pdf_remote=?,xml_remote=?,document_error=?,authorized_at=COALESCE(authorized_at,?),
        last_checked_at=?,consultation_count=consultation_count+1,updated_at=?,error_message=NULL WHERE id=?`)
        .run(
          number, metadata.fiscalKey || invoice.fiscal_key || null, metadata.verificationCode || invoice.verification_code || null,
          JSON.stringify(response), documents.pdfPath, documents.xmlPath, documents.pdfRemote, documents.xmlRemote,
          documents.documentError, now, now, now, invoice.id,
        );
      if (previousStatus !== 'authorized') addEvent(db, invoice.id, 'authorized', number ? `NFS-e ${number} autorizada.` : 'NFS-e autorizada.', { source, response });
      if (!documents.documentError && (documents.pdfPath || documents.xmlPath) && (!invoice.pdf_path && !invoice.xml_path)) {
        addEvent(db, invoice.id, 'documents', 'Documentos fiscais disponíveis para download.', { source });
      }
    } else if (status === 'error') {
      const message = extractErrorMessage(response, 'A emissão foi rejeitada.');
      db.prepare(`UPDATE invoices SET status='error',focus_response_json=?,error_message=?,last_checked_at=?,
        consultation_count=consultation_count+1,updated_at=? WHERE id=?`)
        .run(JSON.stringify(response), message, now, now, invoice.id);
      if (previousStatus !== 'error' || invoice.error_message !== message) addEvent(db, invoice.id, 'error', message, { source, response });
    } else if (status === 'cancelled') {
      db.prepare(`UPDATE invoices SET status='cancelled',focus_response_json=?,cancelled_at=COALESCE(cancelled_at,?),
        last_checked_at=?,consultation_count=consultation_count+1,updated_at=? WHERE id=?`)
        .run(JSON.stringify(response), now, now, now, invoice.id);
      if (previousStatus !== 'cancelled') addEvent(db, invoice.id, 'cancelled', 'NFS-e cancelada.', { source, response });
    } else {
      db.prepare(`UPDATE invoices SET status='processing',focus_response_json=?,last_checked_at=?,
        consultation_count=consultation_count+1,updated_at=? WHERE id=?`)
        .run(JSON.stringify(response), now, now, invoice.id);
      if (!['processing', 'sending'].includes(previousStatus)) addEvent(db, invoice.id, 'processing', 'NFS-e em processamento.', { source, response });
    }
    return getInvoice(invoice.id);
  }

  async function refreshInvoice(invoice, { force = false } = {}) {
    const missingDocuments = invoice.status === 'authorized' && (!localDocumentExists(invoice.pdf_path) || !localDocumentExists(invoice.xml_path));
    if (!['processing', 'sending'].includes(invoice.status) && !missingDocuments) return getInvoice(invoice.id);
    if (!force && invoice.last_checked_at) {
      const elapsed = Date.now() - new Date(invoice.last_checked_at).getTime();
      if (Number.isFinite(elapsed) && elapsed < config.focus.pollIntervalMs) return getInvoice(invoice.id);
    }
    try {
      const response = await focus.consult(invoice.focus_reference, { ...invoice, issuedAt: invoice.issued_at });
      return await applyFocusResponse(invoice, response, 'consulta');
    } catch (error) {
      const now = isoNow();
      if (invoice.status === 'authorized') {
        db.prepare('UPDATE invoices SET document_error=?,last_checked_at=?,updated_at=? WHERE id=?').run(error.message, now, now, invoice.id);
      } else {
        db.prepare('UPDATE invoices SET error_message=?,last_checked_at=?,updated_at=? WHERE id=?').run(error.message, now, now, invoice.id);
      }
      const previous = db.prepare(`SELECT message FROM invoice_events WHERE invoice_id=? AND type='consult_error' ORDER BY id DESC LIMIT 1`).get(invoice.id);
      const message = `Falha ao consultar a Focus: ${error.message}`;
      if (previous?.message !== message) addEvent(db, invoice.id, 'consult_error', message, { code: error.code });
      throw error;
    }
  }

  async function ensureDocument(invoice, kind) {
    const currentPath = kind === 'pdf' ? invoice.pdf_path : invoice.xml_path;
    if (localDocumentExists(currentPath)) return currentPath;
    let refreshed = await refreshInvoice(invoice, { force: true }).catch(() => getInvoice(invoice.id));
    let filePath = kind === 'pdf' ? refreshed.pdf_path : refreshed.xml_path;
    if (localDocumentExists(filePath)) return filePath;

    const remote = kind === 'pdf' ? refreshed.pdf_remote : refreshed.xml_remote;
    if (remote) {
      try {
        filePath = await focus.download(remote, documentTarget(refreshed, kind));
        const column = kind === 'pdf' ? 'pdf_path' : 'xml_path';
        db.prepare(`UPDATE invoices SET ${column}=?,document_error=NULL,updated_at=? WHERE id=?`).run(filePath, isoNow(), refreshed.id);
        return filePath;
      } catch (error) {
        db.prepare('UPDATE invoices SET document_error=?,updated_at=? WHERE id=?').run(error.message, isoNow(), refreshed.id);
      }
    }
    return null;
  }

  async function api(req, res, url) {
    if (req.method === 'GET' && url.pathname === '/api/health') {
      return sendJson(res, 200, {
        ok: true,
        app: config.appName,
        demoMode: config.demoMode,
        environment: config.focus.environment,
        runtimeMode: config.runtimeMode,
        allowProduction: config.allowProduction,
        tokenConfigured: Boolean(config.focus.token),
        dpsSeries: config.dpsSeries,
        webhookConfigured: Boolean(config.focus.webhookSecret),
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/webhooks/focus') {
      if (!config.focus.webhookSecret) return sendJson(res, 404, { error: 'Webhook não configurado.' });
      const secret = req.headers['x-personalize-webhook-secret'];
      if (!safeSecretEquals(secret, config.focus.webhookSecret)) return sendJson(res, 401, { error: 'Webhook não autorizado.' });
      const body = await readBody(req);
      const reference = webhookReference(body);
      if (!reference) return sendJson(res, 400, { error: 'A notificação não contém a referência da NFS-e.' });
      const invoice = getInvoiceByReference(reference);
      if (!invoice) {
        addAudit(db, null, 'focus_webhook_unknown', 'invoice', reference, { status: body.status || null });
        return sendJson(res, 202, { ok: true, ignored: true });
      }
      await applyFocusResponse(invoice, body, 'webhook');
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === 'POST' && url.pathname === '/api/auth/login') {
      const body = await readBody(req);
      const email = String(body.email || '').trim().toLowerCase();
      const user = db.prepare('SELECT * FROM users WHERE email=? AND active=1').get(email);
      if (!user || !verifyPassword(body.password || '', user.password_hash)) return sendJson(res, 401, { error: 'E-mail ou senha inválidos.' });
      const token = randomToken();
      const expiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
      db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)')
        .run(sessionDigest(token, config.sessionSecret), user.id, expiresAt, isoNow());
      addAudit(db, user.id, 'login');
      return sendJson(res, 200, { user: publicUser(user) }, {
        'Set-Cookie': `${cookieName}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200`,
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
      const token = parseCookies(req.headers.cookie || '')[cookieName];
      if (token) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(sessionDigest(token, config.sessionSecret));
      return sendJson(res, 200, { ok: true }, { 'Set-Cookie': `${cookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0` });
    }

    if (req.method === 'GET' && url.pathname === '/api/auth/me') {
      const user = authenticate(req);
      return user
        ? sendJson(res, 200, {
          user: publicUser(user), demoMode: config.demoMode, environment: config.focus.environment,
          runtimeMode: config.runtimeMode, allowProduction: config.allowProduction, pollIntervalMs: config.focus.pollIntervalMs,
        })
        : sendJson(res, 401, { error: 'Não autenticado.' });
    }

    const user = requireUser(req, res);
    if (!user) return;

    if (req.method === 'GET' && url.pathname === '/api/services') {
      return sendJson(res, 200, { items: db.prepare('SELECT * FROM service_profiles WHERE active=1 ORDER BY name').all() });
    }

    if (req.method === 'GET' && url.pathname === '/api/dashboard') {
      const admin = user.role === 'admin';
      const params = admin ? [] : [user.id];
      const counts = db.prepare(`SELECT status,COUNT(*) total FROM invoices${admin ? '' : ' WHERE owner_user_id=?'} GROUP BY status`).all(...params);
      const drafts = db.prepare(`SELECT COUNT(*) total FROM drafts WHERE status='draft'${admin ? '' : ' AND owner_user_id=?'}`).get(...params)?.total || 0;
      const recent = db.prepare(`SELECT i.id,i.nfse_number,i.focus_reference,i.client_name,i.service_amount,i.status,i.environment,i.runtime_mode,i.created_at,
        s.name service_name,u.name owner_name FROM invoices i JOIN service_profiles s ON s.id=i.service_profile_id
        JOIN users u ON u.id=i.owner_user_id ${admin ? '' : 'WHERE i.owner_user_id=?'} ORDER BY i.id DESC LIMIT 8`).all(...params);
      return sendJson(res, 200, { counts: Object.fromEntries(counts.map((item) => [item.status, item.total])), drafts, recent });
    }

    const lookupCnpj = url.pathname.match(/^\/api\/lookup\/cnpj\/(\d+)$/);
    if (req.method === 'GET' && lookupCnpj) return sendJson(res, 200, await focus.lookupCnpj(lookupCnpj[1]));
    const lookupCep = url.pathname.match(/^\/api\/lookup\/cep\/(\d+)$/);
    if (req.method === 'GET' && lookupCep) return sendJson(res, 200, await focus.lookupCep(lookupCep[1]));

    if (req.method === 'GET' && url.pathname === '/api/drafts') {
      const admin = user.role === 'admin';
      const rows = db.prepare(`SELECT d.*,u.name owner_name FROM drafts d JOIN users u ON u.id=d.owner_user_id
        ${admin ? '' : 'WHERE d.owner_user_id=?'} ORDER BY d.updated_at DESC`).all(...(admin ? [] : [user.id]));
      return sendJson(res, 200, { items: rows.map((row) => ({ ...row, data: parseJson(row.data_json) })) });
    }

    if (req.method === 'POST' && url.pathname === '/api/drafts') {
      const body = await readBody(req);
      const now = isoNow();
      const result = db.prepare(`INSERT INTO drafts(owner_user_id,status,data_json,created_at,updated_at) VALUES(?,'draft',?,?,?)`)
        .run(user.id, JSON.stringify(body), now, now);
      addAudit(db, user.id, 'draft_created', 'draft', result.lastInsertRowid);
      return sendJson(res, 201, { id: Number(result.lastInsertRowid) });
    }

    const draftMatch = url.pathname.match(/^\/api\/drafts\/(\d+)$/);
    if (draftMatch) {
      const draft = db.prepare('SELECT * FROM drafts WHERE id=?').get(Number(draftMatch[1]));
      if (!draft || !canAccess(user, draft)) return sendJson(res, 404, { error: 'Rascunho não encontrado.' });
      if (req.method === 'GET') return sendJson(res, 200, { ...draft, data: parseJson(draft.data_json) });
      if (req.method === 'PUT') {
        if (draft.status !== 'draft') return sendJson(res, 409, { error: 'Esse rascunho já foi emitido.' });
        db.prepare('UPDATE drafts SET data_json=?,updated_at=? WHERE id=?').run(JSON.stringify(await readBody(req)), isoNow(), draft.id);
        addAudit(db, user.id, 'draft_updated', 'draft', draft.id);
        return sendJson(res, 200, { ok: true });
      }
      if (req.method === 'DELETE') {
        if (draft.status !== 'draft') return sendJson(res, 409, { error: 'Esse rascunho já foi emitido.' });
        db.prepare('DELETE FROM drafts WHERE id=?').run(draft.id);
        addAudit(db, user.id, 'draft_deleted', 'draft', draft.id);
        return sendJson(res, 200, { ok: true });
      }
    }

    const issueMatch = url.pathname.match(/^\/api\/drafts\/(\d+)\/issue$/);
    if (req.method === 'POST' && issueMatch) {
      const draft = db.prepare('SELECT * FROM drafts WHERE id=?').get(Number(issueMatch[1]));
      if (!draft || !canAccess(user, draft)) return sendJson(res, 404, { error: 'Rascunho não encontrado.' });
      if (draft.invoice_id) return sendJson(res, 200, { invoice: invoiceDto(getInvoice(draft.invoice_id)), reused: true });
      const data = parseJson(draft.data_json);
      const errors = validateDraft(data);
      if (errors.length) return sendJson(res, 422, { error: 'Revise os campos obrigatórios.', fields: errors });
      const service = db.prepare('SELECT * FROM service_profiles WHERE id=? AND active=1').get(data.serviceProfileId);
      if (!service) return sendJson(res, 422, { error: 'O serviço selecionado está indisponível.' });
      const dpsNumber = nextDpsNumber(db, config);
      const reference = createReference();
      const now = isoNow();
      const payload = buildPayload({ data, service, company: config.company, dpsSeries: config.dpsSeries, dpsNumber, emittedAt: new Date() });
      const insert = db.prepare(`INSERT INTO invoices(owner_user_id,draft_id,focus_reference,dps_series,dps_number,status,client_name,
        client_document,service_profile_id,service_description,service_amount,payload_json,environment,runtime_mode,created_at,updated_at)
        VALUES(?,?,?,?,?,'sending',?,?,?,?,?,?,?,?,?,?)`).run(
          draft.owner_user_id, draft.id, reference, config.dpsSeries, dpsNumber, data.clientName, digits(data.clientDocument),
          data.serviceProfileId, data.serviceDescription, Number(data.serviceAmount), JSON.stringify(payload),
          config.focus.environment, config.runtimeMode, now, now,
        );
      const invoiceId = Number(insert.lastInsertRowid);
      db.prepare(`UPDATE drafts SET status='issued',invoice_id=?,updated_at=? WHERE id=?`).run(invoiceId, now, draft.id);
      db.prepare('UPDATE invoices SET issued_at=?,updated_at=? WHERE id=?').run(now, now, invoiceId);
      addEvent(db, invoiceId, 'created', `Emissão preparada no modo ${config.runtimeMode}.`, { reference, dpsSeries: config.dpsSeries, dpsNumber });
      addAudit(db, user.id, 'invoice_issue_requested', 'invoice', invoiceId, { reference, runtimeMode: config.runtimeMode });
      try {
        const response = await focus.issue(reference, payload);
        const updated = await applyFocusResponse(getInvoice(invoiceId), response, 'envio');
        const responseStatus = updated.status === 'processing' ? 202 : 200;
        return sendJson(res, responseStatus, { invoice: invoiceDto(updated) });
      } catch (error) {
        db.prepare(`UPDATE invoices SET status='error',focus_response_json=?,error_message=?,updated_at=? WHERE id=?`)
          .run(JSON.stringify(error.response || null), error.message, isoNow(), invoiceId);
        addEvent(db, invoiceId, 'error', error.message, error.response || { code: error.code });
        return sendJson(res, error.status || 422, { error: error.message, details: error.response || null, invoice: invoiceDto(getInvoice(invoiceId)) });
      }
    }

    if (req.method === 'GET' && url.pathname === '/api/invoices') {
      const clauses = [];
      const params = [];
      if (user.role !== 'admin') { clauses.push('i.owner_user_id=?'); params.push(user.id); }
      const status = url.searchParams.get('status');
      const search = String(url.searchParams.get('search') || '').trim();
      if (status) { clauses.push('i.status=?'); params.push(status); }
      if (search) {
        clauses.push('(i.client_name LIKE ? OR i.client_document LIKE ? OR i.nfse_number LIKE ? OR i.focus_reference LIKE ? OR i.fiscal_key LIKE ?)');
        const term = `%${search}%`;
        params.push(term, term, term, term, term);
      }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      const items = db.prepare(`SELECT i.id,i.nfse_number,i.focus_reference,i.fiscal_key,i.client_name,i.client_document,i.service_amount,i.status,
        i.environment,i.runtime_mode,i.created_at,i.authorized_at,i.cancelled_at,s.name service_name,u.name owner_name FROM invoices i
        JOIN service_profiles s ON s.id=i.service_profile_id JOIN users u ON u.id=i.owner_user_id ${where}
        ORDER BY i.id DESC LIMIT 200`).all(...params);
      return sendJson(res, 200, { items });
    }

    const invoiceMatch = url.pathname.match(/^\/api\/invoices\/(\d+)$/);
    if (req.method === 'GET' && invoiceMatch) {
      let invoice = getInvoice(Number(invoiceMatch[1]));
      if (!invoice || !canAccess(user, invoice)) return sendJson(res, 404, { error: 'Nota não encontrada.' });
      invoice = await refreshInvoice(invoice).catch(() => getInvoice(invoice.id));
      return sendJson(res, 200, { invoice: invoiceDto(invoice) });
    }

    const refreshMatch = url.pathname.match(/^\/api\/invoices\/(\d+)\/refresh$/);
    if (req.method === 'POST' && refreshMatch) {
      const invoice = getInvoice(Number(refreshMatch[1]));
      if (!invoice || !canAccess(user, invoice)) return sendJson(res, 404, { error: 'Nota não encontrada.' });
      return sendJson(res, 200, { invoice: invoiceDto(await refreshInvoice(invoice, { force: true })) });
    }

    const resendHookMatch = url.pathname.match(/^\/api\/invoices\/(\d+)\/resend-webhook$/);
    if (req.method === 'POST' && resendHookMatch) {
      if (user.role !== 'admin') return sendJson(res, 403, { error: 'Somente administradores podem solicitar o reenvio.' });
      const invoice = getInvoice(Number(resendHookMatch[1]));
      if (!invoice) return sendJson(res, 404, { error: 'Nota não encontrada.' });
      const response = await focus.resendWebhook(invoice.focus_reference);
      addAudit(db, user.id, 'focus_webhook_resent', 'invoice', invoice.id);
      return sendJson(res, 200, { ok: true, response });
    }

    const cancelMatch = url.pathname.match(/^\/api\/invoices\/(\d+)\/cancel$/);
    if (req.method === 'POST' && cancelMatch) {
      if (user.role !== 'admin') return sendJson(res, 403, { error: 'Somente administradores podem cancelar notas.' });
      const invoice = getInvoice(Number(cancelMatch[1]));
      if (!invoice) return sendJson(res, 404, { error: 'Nota não encontrada.' });
      if (invoice.status !== 'authorized') return sendJson(res, 409, { error: 'Somente notas autorizadas podem ser canceladas.' });
      const justification = String((await readBody(req)).justification || '').trim();
      if (justification.length < 15 || justification.length > 255) return sendJson(res, 422, { error: 'Informe uma justificativa entre 15 e 255 caracteres.' });
      const response = await focus.cancel(invoice.focus_reference, justification);
      const cancelStatus = mapStatus(response);
      if (cancelStatus !== 'cancelled') {
        const message = extractErrorMessage(response, 'A Focus não confirmou o cancelamento da NFS-e.');
        db.prepare('UPDATE invoices SET focus_response_json=?,error_message=?,updated_at=? WHERE id=?')
          .run(JSON.stringify(response), message, isoNow(), invoice.id);
        addEvent(db, invoice.id, 'cancel_error', message, { justification, response });
        return sendJson(res, 422, { error: message, invoice: invoiceDto(getInvoice(invoice.id)) });
      }
      const now = isoNow();
      db.prepare(`UPDATE invoices SET status='cancelled',focus_response_json=?,cancelled_at=?,updated_at=?,error_message=NULL WHERE id=?`)
        .run(JSON.stringify(response), now, now, invoice.id);
      addEvent(db, invoice.id, 'cancelled', 'NFS-e cancelada pelo administrador.', { justification, response });
      addAudit(db, user.id, 'invoice_cancelled', 'invoice', invoice.id, { justification });
      return sendJson(res, 200, { invoice: invoiceDto(getInvoice(invoice.id)) });
    }

    const duplicateMatch = url.pathname.match(/^\/api\/invoices\/(\d+)\/duplicate$/);
    if (req.method === 'POST' && duplicateMatch) {
      const invoice = getInvoice(Number(duplicateMatch[1]));
      if (!invoice || !canAccess(user, invoice)) return sendJson(res, 404, { error: 'Nota não encontrada.' });
      const payload = parseJson(invoice.payload_json);
      const draftData = {
        clientDocument: invoice.client_document,
        clientName: invoice.client_name,
        clientEmail: payload.email_tomador || '',
        clientPostalCode: payload.cep_tomador || '',
        clientStreet: payload.logradouro_tomador || '',
        clientNumber: payload.numero_tomador || '',
        clientComplement: payload.complemento_tomador || '',
        clientNeighborhood: payload.bairro_tomador || '',
        clientCityCode: payload.codigo_municipio_tomador || '',
        clientCity: '',
        clientState: '',
        serviceProfileId: invoice.service_profile_id,
        serviceCityCode: payload.codigo_municipio_prestacao || '',
        serviceCity: '',
        serviceState: '',
        serviceDescription: invoice.service_description,
        serviceAmount: invoice.service_amount,
        competenceDate: new Date().toISOString().slice(0, 10),
      };
      const now = isoNow();
      const result = db.prepare(`INSERT INTO drafts(owner_user_id,status,data_json,created_at,updated_at) VALUES(?,'draft',?,?,?)`)
        .run(user.id, JSON.stringify(draftData), now, now);
      return sendJson(res, 201, { id: Number(result.lastInsertRowid) });
    }

    const documentMatch = url.pathname.match(/^\/api\/invoices\/(\d+)\/(pdf|xml)$/);
    if (req.method === 'GET' && documentMatch) {
      const invoice = getInvoice(Number(documentMatch[1]));
      if (!invoice || !canAccess(user, invoice)) return sendJson(res, 404, { error: 'Nota não encontrada.' });
      const kind = documentMatch[2];
      const filePath = await ensureDocument(invoice, kind);
      if (!filePath || !localDocumentExists(filePath)) return sendJson(res, 404, { error: 'Documento ainda não disponível na Focus. Atualize a situação da nota e tente novamente.' });
      const stat = fs.statSync(filePath);
      res.writeHead(200, {
        'Content-Type': kind === 'pdf' ? 'application/pdf' : 'application/xml',
        'Content-Length': stat.size,
        'Content-Disposition': `attachment; filename="${invoice.nfse_number || invoice.focus_reference}.${kind}"`,
      });
      fs.createReadStream(filePath).pipe(res);
      return;
    }

    return sendJson(res, 404, { error: 'Rota não encontrada.' });
  }

  function staticFile(res, url) {
    const relative = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
    const filePath = path.resolve(config.publicDirectory, relative);
    if (!filePath.startsWith(config.publicDirectory) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return fs.createReadStream(path.join(config.publicDirectory, 'index.html')).pipe(res);
    }
    const extension = path.extname(filePath);
    const mime = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' }[extension] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': extension === '.html' ? 'no-store' : 'public, max-age=300' });
    fs.createReadStream(filePath).pipe(res);
  }

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    try {
      if (url.pathname.startsWith('/api/')) await api(req, res, url);
      else staticFile(res, url);
    } catch (error) {
      console.error('[PersonalizeNF]', error);
      if (!res.headersSent) sendJson(res, error.status || 500, { error: error.message || 'Erro interno.' });
      else res.end();
    }
  });
}

module.exports = { createServer, safeSecretEquals, webhookReference };
