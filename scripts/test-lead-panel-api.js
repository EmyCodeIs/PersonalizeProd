'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const originalCwd = process.cwd();
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'personalize-lead-panel-'));
process.chdir(tempDir);
process.env.STORAGE_DRIVER = 'file';
process.env.LEAD_PANEL_ENABLED = 'true';

function createResponse() {
  return {
    statusCode: null,
    headers: {},
    chunks: [],
    writeHead(statusCode, headers = {}) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end(content = '') {
      this.chunks.push(Buffer.isBuffer(content) ? content : Buffer.from(String(content)));
      this.body = Buffer.concat(this.chunks).toString('utf8');
      this.finished = true;
    },
  };
}

async function invoke(handler, { method = 'GET', pathname = '/', authorized = true, body = null } = {}) {
  const request = new EventEmitter();
  request.method = method;
  request.url = pathname;
  request.headers = {};
  const response = createResponse();
  const url = new URL(pathname, 'http://localhost');
  const promise = handler({ request, response, url, authorized, channel: null });
  process.nextTick(() => {
    if (body !== null) request.emit('data', Buffer.from(JSON.stringify(body)));
    request.emit('end');
  });
  const handled = await promise;
  return { handled, response, json: () => JSON.parse(response.body || '{}') };
}

(async () => {
  try {
    const publicDir = path.join(tempDir, 'public', 'leads');
    fs.mkdirSync(publicDir, { recursive: true });
    fs.writeFileSync(path.join(publicDir, 'index.html'), '<!doctype html><title>Leads parados</title>', 'utf8');
    fs.writeFileSync(path.join(publicDir, 'app.js'), "console.log('leads');", 'utf8');
    fs.writeFileSync(path.join(publicDir, 'styles.css'), 'body{}', 'utf8');

    const Operations = require('../src/services/leadOperationStore');
    const { handleLeadPanelRequest, safeStaticPath } = require('../src/services/leadPanelApi');

    assert.equal(safeStaticPath('/leads'), path.join(publicDir, 'index.html'));
    assert.equal(safeStaticPath('/leads/../../package.json'), null);

    let result = await invoke(handleLeadPanelRequest, { pathname: '/leads' });
    assert.equal(result.handled, true);
    assert.equal(result.response.statusCode, 200);
    assert.match(result.response.body, /Leads parados/);
    assert.match(result.response.headers['Content-Type'], /text\/html/);

    result = await invoke(handleLeadPanelRequest, { pathname: '/api/leads', authorized: false });
    assert.equal(result.response.statusCode, 401);
    assert.equal(result.json().error, 'unauthorized');

    result = await invoke(handleLeadPanelRequest, { pathname: '/api/leads', authorized: true });
    assert.equal(result.response.statusCode, 200);
    assert.equal(result.json().report.total, 0);
    assert.ok(result.json().outboundLedger);

    const operation = Operations.ensureLead({
      conversationKey: 'wa:5531999999761@c.us',
      clientId: '5531999999761@c.us',
      customerName: 'Lead Painel',
      lastCustomerMessageAt: '2026-08-03T10:00:00.000Z',
      idleHours: 26,
    });

    result = await invoke(handleLeadPanelRequest, {
      method: 'POST',
      pathname: '/api/leads/action',
      authorized: true,
      body: {
        id: operation.id,
        status: 'CONTACTED',
        actor: 'Emy',
        assignedTo: 'Emy',
        note: 'Busca ativa realizada.',
      },
    });
    assert.equal(result.response.statusCode, 200);
    assert.equal(result.json().operation.status, 'CONTACTED');
    assert.equal(result.json().operation.assignedTo, 'Emy');
    assert.equal(result.json().operation.note, 'Busca ativa realizada.');

    result = await invoke(handleLeadPanelRequest, {
      pathname: `/api/leads/audit?id=${encodeURIComponent(operation.id)}`,
      authorized: true,
    });
    assert.equal(result.response.statusCode, 200);
    assert.ok(result.json().operation.audit.some((item) => item.action === 'STATUS_CHANGED'));

    result = await invoke(handleLeadPanelRequest, {
      pathname: '/api/leads/outbound-issues',
      authorized: true,
    });
    assert.equal(result.response.statusCode, 200);
    assert.equal(result.json().total, 0);

    console.log('✅ Painel de leads: arquivos estáticos, autenticação, listagem, ação e auditoria verificados.');
  } finally {
    process.chdir(originalCwd);
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
