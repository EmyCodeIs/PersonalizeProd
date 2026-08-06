'use strict';

const http = require('http');
const { connectionConfig } = require('../config/connectionConfig');
const { getActiveConnectionSupervisor } = require('./connectionSupervisor');
const { handleLeadPanelRequest } = require('./leadPanelApi');

const host = process.env.QR_ADMIN_HOST || '127.0.0.1';
const port = Number(process.env.QR_ADMIN_PORT || 3210);

let clientRef = null;
let channelRef = null;
let started = false;
let serverRef = null;

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(payload));
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function setQrAdminClient(client) {
  clientRef = client || null;
}

function setQrAdminChannel(channel) {
  channelRef = channel || null;
  if (channel?.client) clientRef = channel.client;
}

function authorizationToken(request) {
  const direct = String(request.headers['x-admin-token'] || '').trim();
  if (direct) return direct;
  const authorization = String(request.headers.authorization || '').trim();
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function detailAuthorized(request) {
  if (!connectionConfig.detailToken) return true;
  return authorizationToken(request) === connectionConfig.detailToken;
}

function connectionSnapshot() {
  const supervisor = getActiveConnectionSupervisor();
  return supervisor?.snapshot?.() || {
    state: 'STARTING',
    ready: false,
    generation: 0,
    rawState: '',
    clientAttached: Boolean(clientRef),
    processUptimeSeconds: Math.floor(process.uptime()),
  };
}

function inboxSnapshot() {
  try {
    const Inbox = require('./messageInboxStore');
    return Inbox.stats();
  } catch (error) {
    return { unavailable: true, error: String(error?.message || error) };
  }
}

function operationalSnapshot() {
  const output = {};
  try { output.outboundLedger = require('./outboundLedgerStore').stats(); } catch (error) {
    output.outboundLedger = { unavailable: true, error: String(error?.message || error) };
  }
  try { output.leadOperations = require('./leadOperationStore').stats(); } catch (error) {
    output.leadOperations = { unavailable: true, error: String(error?.message || error) };
  }
  try {
    const report = require('./leadAbandonmentReport').buildReport();
    output.leads = {
      total: report.total,
      pendingNotification: report.pendingNotification,
      pendingAction: report.pendingAction,
      contacted: report.contacted,
      discarded: report.discarded,
    };
  } catch (error) {
    output.leads = { unavailable: true, error: String(error?.message || error) };
  }
  return output;
}

function readinessPayload() {
  const connection = connectionSnapshot();
  return {
    ok: connection.ready === true,
    live: true,
    ready: connection.ready === true,
    connection: {
      state: connection.state,
      generation: connection.generation,
      rawState: connection.rawState,
      updatedAt: connection.updatedAt,
      lastReadyAt: connection.lastReadyAt,
      lastInboundAt: connection.lastInboundAt,
      lastOutboundAt: connection.lastOutboundAt,
      recoveryAttempts: connection.recoveryAttempts,
      exitRequested: connection.exitRequested,
    },
  };
}

function detailPayload() {
  const connection = connectionSnapshot();
  return {
    ok: true,
    live: true,
    ready: connection.ready === true,
    pid: process.pid,
    node: process.version,
    uptimeSeconds: Math.floor(process.uptime()),
    memory: process.memoryUsage(),
    connection,
    inbox: inboxSnapshot(),
    operations: operationalSnapshot(),
    client: {
      attached: Boolean(clientRef),
      channelAttached: Boolean(channelRef),
      hasPage: Boolean(clientRef?.page || clientRef?.waPage),
      canGetConnectionState: typeof clientRef?.getConnectionState === 'function',
      canCheckConnected: typeof clientRef?.isConnected === 'function',
      canCheckMainReady: typeof clientRef?.isMainReady === 'function',
      canLogout: typeof clientRef?.logout === 'function',
    },
  };
}

function createRequestHandler() {
  return async (request, response) => {
    const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);

    if (request.method === 'GET' && url.pathname === '/health/live') {
      sendJson(response, 200, {
        ok: true,
        live: true,
        pid: process.pid,
        uptimeSeconds: Math.floor(process.uptime()),
      });
      return;
    }

    if (request.method === 'GET' && ['/health', '/health/ready'].includes(url.pathname)) {
      const payload = readinessPayload();
      sendJson(response, payload.ready ? 200 : 503, payload);
      return;
    }

    if (request.method === 'GET' && url.pathname === '/health/detail') {
      if (!detailAuthorized(request)) {
        sendJson(response, 401, { ok: false, error: 'unauthorized' });
        return;
      }
      sendJson(response, 200, detailPayload());
      return;
    }

    if (request.method === 'POST' && url.pathname === '/recover') {
      if (!detailAuthorized(request)) {
        sendJson(response, 401, { ok: false, error: 'unauthorized' });
        return;
      }
      const supervisor = getActiveConnectionSupervisor();
      if (!supervisor) {
        sendJson(response, 503, { ok: false, error: 'supervisor_unavailable' });
        return;
      }
      const result = await supervisor.recover('admin_request');
      sendJson(response, 200, { ok: true, result, connection: supervisor.snapshot() });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/logout') {
      if (!detailAuthorized(request)) {
        sendJson(response, 401, { ok: false, error: 'unauthorized' });
        return;
      }
      try {
        await readBody(request);
        console.warn(
          `[QR ADMIN] logout administrativo solicitado | origem=${request.socket?.remoteAddress || 'desconhecida'}`,
        );
        if (!clientRef || typeof clientRef.logout !== 'function') {
          sendJson(response, 503, { ok: false, error: 'client_unavailable' });
          return;
        }

        const result = await clientRef.logout();
        sendJson(response, 200, { ok: result !== false });
      } catch (error) {
        const message = String(error?.message || error || 'logout_failed');
        if (/Execution context was destroyed/i.test(message)) {
          sendJson(response, 200, { ok: true, warning: 'context_destroyed_after_logout' });
          return;
        }
        sendJson(response, 500, { ok: false, error: message });
      }
      return;
    }

    const handled = await handleLeadPanelRequest({
      request,
      response,
      url,
      authorized: detailAuthorized(request),
      channel: channelRef,
    });
    if (handled) return;

    sendJson(response, 404, { ok: false, error: 'not_found' });
  };
}

function startQrAdminServer() {
  if (started) return serverRef;

  const server = http.createServer(createRequestHandler());
  server.listen(port, host, () => {
    const address = server.address();
    const resolvedPort = typeof address === 'object' && address ? address.port : port;
    console.log(`[QR ADMIN] ouvindo em http://${host}:${resolvedPort}`);
    console.log(`[LEADS 24H] painel operacional em http://${host}:${resolvedPort}/leads`);
  });

  serverRef = server;
  started = true;
  return server;
}

function stopQrAdminServer() {
  return new Promise((resolve) => {
    if (!serverRef) {
      started = false;
      resolve(false);
      return;
    }
    const current = serverRef;
    serverRef = null;
    started = false;
    current.close(() => resolve(true));
  });
}

function getQrAdminServer() {
  return serverRef;
}

module.exports = {
  authorizationToken,
  connectionSnapshot,
  createRequestHandler,
  detailAuthorized,
  detailPayload,
  getQrAdminServer,
  readinessPayload,
  setQrAdminChannel,
  setQrAdminClient,
  startQrAdminServer,
  stopQrAdminServer,
};
