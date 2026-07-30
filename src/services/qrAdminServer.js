'use strict';

const http = require('http');
const Lifecycle = require('../core/runtimeLifecycle');

let clientRef = null;
let serverRef = null;
let started = false;

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
    let total = 0;
    request.on('data', (chunk) => {
      total += chunk.length;
      if (total > 64 * 1024) {
        const error = new Error('request_body_too_large');
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

function setQrAdminClient(client) {
  clientRef = client || null;
}

function closeQrAdminServer() {
  return new Promise((resolve) => {
    if (!serverRef) {
      started = false;
      resolve(false);
      return;
    }

    const server = serverRef;
    serverRef = null;
    started = false;
    try { server.closeIdleConnections?.(); } catch (_) {}
    server.close(() => resolve(true));
  });
}

function startQrAdminServer(options = {}) {
  if (started && serverRef) return serverRef;

  const host = String(options.host || process.env.QR_ADMIN_HOST || '127.0.0.1');
  const port = Number(options.port ?? process.env.QR_ADMIN_PORT ?? 3210);

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);

    if (request.method === 'GET' && url.pathname === '/live') {
      const snapshot = Lifecycle.liveSnapshot();
      sendJson(response, snapshot.ok ? 200 : 503, snapshot);
      return;
    }

    if (request.method === 'GET' && url.pathname === '/ready') {
      const snapshot = await Lifecycle.readinessSnapshot();
      sendJson(response, snapshot.ok ? 200 : 503, snapshot);
      return;
    }

    if (request.method === 'GET' && url.pathname === '/health') {
      const snapshot = await Lifecycle.healthSnapshot();
      sendJson(response, snapshot.ok ? 200 : 503, snapshot);
      return;
    }

    if (request.method === 'POST' && url.pathname === '/logout') {
      try {
        await readBody(request);
        if (!clientRef || typeof clientRef.logout !== 'function') {
          sendJson(response, 503, { ok: false, error: 'client_unavailable' });
          return;
        }

        const result = await clientRef.logout();
        Lifecycle.markConnectionState('LOGOUT');
        sendJson(response, 200, { ok: result !== false });
      } catch (error) {
        const message = String(error?.message || error || 'logout_failed');
        Lifecycle.recordError(error);
        if (/Execution context was destroyed/i.test(message)) {
          Lifecycle.markConnectionState('LOGOUT');
          sendJson(response, 200, { ok: true, warning: 'context_destroyed_after_logout' });
          return;
        }
        sendJson(response, 500, {
          ok: false,
          error: message,
        });
      }
      return;
    }

    sendJson(response, 404, { ok: false, error: 'not_found' });
  });

  server.on('error', (error) => {
    Lifecycle.recordError(error);
    console.error('[QR ADMIN] falha no servidor local:', error?.message || error);
  });

  server.listen(port, host, () => {
    const address = server.address();
    const actualPort = typeof address === 'object' && address ? address.port : port;
    console.log(`[QR ADMIN] ouvindo em http://${host}:${actualPort}`);
  });

  serverRef = server;
  started = true;
  Lifecycle.registerCloser('qr_admin_server', closeQrAdminServer);
  return server;
}

module.exports = {
  closeQrAdminServer,
  setQrAdminClient,
  startQrAdminServer,
  _test: {
    getServer: () => serverRef,
  },
};
