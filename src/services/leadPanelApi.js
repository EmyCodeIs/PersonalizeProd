'use strict';

const fs = require('fs');
const path = require('path');
const LeadReport = require('./leadAbandonmentReport');
const LeadOperations = require('./leadOperationStore');
const OutboundLedger = require('./outboundLedgerStore');
const LeadNotifications = require('./leadNotificationService');
const { leadOperationsConfig } = require('../config/leadOperationsConfig');

const PUBLIC_DIR = path.resolve(process.cwd(), 'public', 'leads');

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(payload));
}

function sendText(response, statusCode, content, headers = {}) {
  response.writeHead(statusCode, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  response.end(content);
}

function readBody(request, maxBytes = 65536) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        const error = new Error('REQUEST_BODY_TOO_LARGE');
        error.code = 'REQUEST_BODY_TOO_LARGE';
        reject(error);
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

async function readJson(request) {
  const raw = await readBody(request);
  if (!raw.trim()) return {};
  try { return JSON.parse(raw); } catch (_) {
    const error = new Error('INVALID_JSON');
    error.code = 'INVALID_JSON';
    throw error;
  }
}

function safeStaticPath(pathname) {
  const relative = pathname === '/leads' || pathname === '/leads/'
    ? 'index.html'
    : pathname.replace(/^\/leads\//, '');
  if (!['index.html', 'app.js', 'styles.css'].includes(relative)) return null;
  return path.join(PUBLIC_DIR, relative);
}

function staticType(filePath) {
  if (filePath.endsWith('.js')) return 'application/javascript; charset=utf-8';
  if (filePath.endsWith('.css')) return 'text/css; charset=utf-8';
  return 'text/html; charset=utf-8';
}

function serveStatic(response, pathname) {
  const filePath = safeStaticPath(pathname);
  if (!filePath || !fs.existsSync(filePath)) return false;
  response.writeHead(200, {
    'Content-Type': staticType(filePath),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
  });
  response.end(fs.readFileSync(filePath));
  return true;
}

function unauthorized(response) {
  sendJson(response, 401, { ok: false, error: 'unauthorized' });
}

function operationPayload(record) {
  if (!record) return null;
  return {
    id: record.id,
    status: record.status,
    assignedTo: record.assignedTo,
    note: record.note,
    seenAt: record.seenAt,
    contactedAt: record.contactedAt,
    discardedAt: record.discardedAt,
    alertStatus: record.alertStatus,
    alertAttempts: record.alertAttempts,
    lastAlertAt: record.lastAlertAt,
    audit: record.audit,
    updatedAt: record.updatedAt,
  };
}

async function handleLeadPanelRequest(context = {}) {
  const { request, response, url, authorized, channel } = context;
  if (!leadOperationsConfig.panelEnabled) return false;

  if (request.method === 'GET' && url.pathname.startsWith('/leads')) {
    if (serveStatic(response, url.pathname)) return true;
  }

  if (!url.pathname.startsWith('/api/leads')) return false;
  if (!authorized) {
    unauthorized(response);
    return true;
  }

  try {
    if (request.method === 'GET' && url.pathname === '/api/leads') {
      const report = LeadReport.buildReport();
      sendJson(response, 200, {
        ok: true,
        report,
        operationStats: LeadOperations.stats(),
        outboundLedger: OutboundLedger.stats(),
        alertConfiguration: {
          enabled: leadOperationsConfig.alertEnabled,
          recipientsConfigured: leadOperationsConfig.alertRecipients.length,
          sendTxt: leadOperationsConfig.alertSendTxt,
          panelUrl: leadOperationsConfig.panelPublicUrl || '/leads',
        },
      });
      return true;
    }

    if (request.method === 'GET' && url.pathname === '/api/leads/transcript') {
      const conversationKey = String(url.searchParams.get('conversationKey') || '').trim();
      const lastCustomerMessageAt = String(url.searchParams.get('lastCustomerMessageAt') || '').trim();
      const lead = LeadReport.findLead(conversationKey, lastCustomerMessageAt);
      if (!lead) {
        sendJson(response, 404, { ok: false, error: 'lead_not_found' });
        return true;
      }
      const content = LeadReport.leadToTxt(lead, { generatedAt: new Date().toISOString() });
      const safeName = String(lead.phone || lead.customerName || 'lead').replace(/[^a-zA-Z0-9_-]+/g, '-');
      sendText(response, 200, content, {
        'Content-Disposition': `attachment; filename="lead-${safeName}.txt"`,
      });
      return true;
    }

    if (request.method === 'GET' && url.pathname === '/api/leads/audit') {
      const id = String(url.searchParams.get('id') || '').trim();
      const record = LeadOperations.getById(id);
      if (!record) {
        sendJson(response, 404, { ok: false, error: 'lead_operation_not_found' });
        return true;
      }
      sendJson(response, 200, { ok: true, operation: operationPayload(record) });
      return true;
    }

    if (request.method === 'POST' && url.pathname === '/api/leads/action') {
      const body = await readJson(request);
      const updated = LeadOperations.updateStatus({
        id: body.id,
        conversationKey: body.conversationKey,
        lastCustomerMessageAt: body.lastCustomerMessageAt,
        status: body.status,
        actor: body.actor || request.headers['x-admin-user'] || 'vendedor',
        assignedTo: body.assignedTo,
        note: body.note,
        source: 'lead_panel',
      });
      sendJson(response, 200, { ok: true, operation: operationPayload(updated) });
      return true;
    }

    if (request.method === 'POST' && url.pathname === '/api/leads/notify') {
      const result = typeof channel?.__runLeadAlerts === 'function'
        ? await channel.__runLeadAlerts('panel')
        : await LeadNotifications.runLeadAlerts(channel, {});
      sendJson(response, 200, { ok: true, result });
      return true;
    }

    if (request.method === 'GET' && url.pathname === '/api/leads/outbound-issues') {
      const issues = OutboundLedger.listAll()
        .filter((record) => ['UNCERTAIN', 'FAILED_FINAL'].includes(record.status))
        .slice(-200)
        .reverse();
      sendJson(response, 200, { ok: true, total: issues.length, issues });
      return true;
    }
  } catch (error) {
    const status = ['INVALID_JSON', 'LEAD_STATUS_INVALID'].includes(error?.code) ? 400 : 500;
    sendJson(response, status, { ok: false, error: error?.code || 'lead_panel_error', message: error?.message || String(error) });
    return true;
  }

  sendJson(response, 404, { ok: false, error: 'not_found' });
  return true;
}

module.exports = {
  handleLeadPanelRequest,
  operationPayload,
  readBody,
  readJson,
  safeStaticPath,
  serveStatic,
};
