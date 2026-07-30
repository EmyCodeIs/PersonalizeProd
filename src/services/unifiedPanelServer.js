'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const COOKIE_NAME = 'personalize_panel_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

function bool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return /^(1|true|yes|sim|on)$/i.test(String(value).trim());
}

function number(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseCookies(header = '') {
  const output = {};
  for (const item of String(header).split(';')) {
    const index = item.indexOf('=');
    if (index < 0) continue;
    const key = item.slice(0, index).trim();
    const value = item.slice(index + 1).trim();
    if (key) output[key] = value;
  }
  return output;
}

function safeEqual(leftValue, rightValue) {
  const left = Buffer.from(String(leftValue || ''));
  const right = Buffer.from(String(rightValue || ''));
  return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right);
}

function sign(value, secret) {
  return crypto.createHmac('sha256', secret).update(value).digest('base64url');
}

function createSession(email, secret) {
  const payload = Buffer.from(JSON.stringify({ email, expiresAt: Date.now() + SESSION_TTL_MS })).toString('base64url');
  return `${payload}.${sign(payload, secret)}`;
}

function readSession(request, secret) {
  const token = parseCookies(request.headers.cookie || '')[COOKIE_NAME] || '';
  const [payload, signature] = token.split('.');
  if (!payload || !signature || !safeEqual(signature, sign(payload, secret))) return null;
  try {
    const session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!session.email || Number(session.expiresAt || 0) <= Date.now()) return null;
    return session;
  } catch (_) {
    return null;
  }
}

function json(response, statusCode, payload, headers = {}) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  response.end(body);
}

function readJsonBody(request, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('Corpo muito grande.'), { status: 413 }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (_) {
        reject(Object.assign(new Error('JSON inválido.'), { status: 400 }));
      }
    });
    request.on('error', reject);
  });
}

function contentType(filePath) {
  return {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
  }[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

function serveStatic(publicRoot, requestPath, response) {
  const relative = requestPath === '/' ? 'index.html' : requestPath.replace(/^\/+/, '');
  let decoded;
  try {
    decoded = decodeURIComponent(relative);
  } catch (_) {
    json(response, 400, { error: 'Caminho inválido.' });
    return;
  }
  const target = path.resolve(publicRoot, decoded);
  if (target !== publicRoot && !target.startsWith(`${publicRoot}${path.sep}`)) {
    json(response, 403, { error: 'Acesso negado.' });
    return;
  }
  fs.readFile(target, (error, bytes) => {
    if (error || !bytes) {
      if (!path.extname(decoded)) return serveStatic(publicRoot, '/', response);
      json(response, 404, { error: 'Arquivo não encontrado.' });
      return;
    }
    response.writeHead(200, {
      'Content-Type': contentType(target),
      'Content-Length': bytes.length,
      'Cache-Control': path.extname(target) === '.html' ? 'no-store' : 'public, max-age=300',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https://personalizeseuambiente.com.br; connect-src 'self'; frame-src 'self' http: https:; base-uri 'none'; frame-ancestors 'self'",
    });
    response.end(bytes);
  });
}

function readConnectionSnapshot(statusPath) {
  try {
    if (!fs.existsSync(statusPath)) {
      return {
        status: 'waiting',
        connectionState: 'SEM SINAL',
        message: 'O bot ainda não publicou o estado da conexão.',
        updatedAt: null,
      };
    }
    const snapshot = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
    return {
      status: snapshot.status || 'waiting',
      connectionState: snapshot.connectionState || '',
      message: snapshot.message || '',
      updatedAt: snapshot.updatedAt || null,
      lastConnectedAt: snapshot.lastConnectedAt || null,
      disconnectedAt: snapshot.disconnectedAt || null,
      disconnectState: snapshot.disconnectState || '',
      attempts: Number(snapshot.attempts || 0),
      pairingCode: snapshot.pairingCode || snapshot.urlCode || '',
      imageSrc: snapshot.status === 'qr' ? snapshot.imageSrc || '' : '',
    };
  } catch (error) {
    return {
      status: 'error',
      connectionState: 'STATUS_INVALIDO',
      message: `Não foi possível ler o estado da conexão: ${error.message}`,
      updatedAt: null,
    };
  }
}

function postLocalJson({ host, port, pathname }) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host, port, path: pathname, method: 'POST', timeout: 15000, headers: { 'Content-Type': 'application/json', 'Content-Length': 2 } }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let payload = {};
        try { payload = text ? JSON.parse(text) : {}; } catch (_) { payload = { raw: text }; }
        if (response.statusCode >= 200 && response.statusCode < 300) resolve(payload);
        else reject(new Error(payload.error || `Serviço interno respondeu HTTP ${response.statusCode}.`));
      });
    });
    request.on('timeout', () => request.destroy(new Error('O serviço interno demorou para responder.')));
    request.on('error', reject);
    request.end('{}');
  });
}

function createPanelConfig() {
  const password = String(
    process.env.PANEL_ADMIN_PASSWORD
    || process.env.ADMIN_PASSWORD
    || process.env.SESSION_ACCESS_PASSWORD
    || '',
  ).trim();
  const explicitSecret = String(process.env.PANEL_SESSION_SECRET || process.env.SESSION_SECRET || '').trim();
  return {
    enabled: bool(process.env.UNIFIED_PANEL_ENABLED, true),
    host: String(process.env.PANEL_HOST || '127.0.0.1').trim(),
    port: Math.max(1, number(process.env.PANEL_PORT, 3030)),
    adminEmail: String(process.env.PANEL_ADMIN_EMAIL || process.env.ADMIN_EMAIL || 'contato@personalizeseuambiente.com.br').trim().toLowerCase(),
    adminPassword: password,
    sessionSecret: explicitSecret || crypto.randomBytes(32).toString('hex'),
    statusPath: path.resolve(process.cwd(), process.env.QR_STATUS_JSON || 'data/qr-status/status.json'),
    publicRoot: path.resolve(process.cwd(), 'public', 'panel'),
    sessionAccessUrl: String(process.env.SESSION_ACCESS_PUBLIC_URL || '').trim(),
    qrAdminHost: String(process.env.QR_ADMIN_HOST || '127.0.0.1').trim(),
    qrAdminPort: Math.max(1, number(process.env.QR_ADMIN_PORT, 3210)),
    fiscalPanelUrl: String(process.env.FISCAL_PANEL_URL || '').trim(),
    fiscalMigrationState: String(process.env.FISCAL_MIGRATION_STATE || 'preparando').trim(),
  };
}

function startUnifiedPanelServer() {
  const config = createPanelConfig();
  if (!config.enabled) {
    console.log('[PAINEL] painel unificado desativado por UNIFIED_PANEL_ENABLED=false');
    return null;
  }
  if (!config.adminPassword) {
    console.warn('[PAINEL] não iniciado: defina PANEL_ADMIN_PASSWORD, ADMIN_PASSWORD ou SESSION_ACCESS_PASSWORD.');
    return null;
  }
  if (!fs.existsSync(config.publicRoot)) {
    console.warn(`[PAINEL] não iniciado: interface ausente em ${config.publicRoot}`);
    return null;
  }

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);

    if (request.method === 'GET' && url.pathname === '/health') {
      json(response, 200, { ok: true, app: 'Personalize', module: 'painel-unificado' });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/auth/login') {
      try {
        const body = await readJsonBody(request);
        const email = String(body.email || '').trim().toLowerCase();
        const password = String(body.password || '');
        if (!safeEqual(email, config.adminEmail) || !safeEqual(password, config.adminPassword)) {
          json(response, 401, { error: 'E-mail ou senha incorretos.' });
          return;
        }
        const secure = String(request.headers['x-forwarded-proto'] || '').toLowerCase() === 'https';
        json(response, 200, { user: { name: 'Personalize', email: config.adminEmail, role: 'admin' } }, {
          'Set-Cookie': `${COOKIE_NAME}=${createSession(config.adminEmail, config.sessionSecret)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${secure ? '; Secure' : ''}`,
        });
      } catch (error) {
        json(response, error.status || 400, { error: error.message });
      }
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/auth/logout') {
      json(response, 200, { ok: true }, { 'Set-Cookie': `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0` });
      return;
    }

    const session = readSession(request, config.sessionSecret);

    if (request.method === 'GET' && url.pathname === '/api/auth/me') {
      if (!session) return json(response, 401, { error: 'Faça login para continuar.' });
      json(response, 200, { user: { name: 'Personalize', email: session.email, role: 'admin' } });
      return;
    }

    if (url.pathname.startsWith('/api/')) {
      if (!session) return json(response, 401, { error: 'Faça login para continuar.' });

      if (request.method === 'GET' && url.pathname === '/api/panel/overview') {
        const connection = readConnectionSnapshot(config.statusPath);
        json(response, 200, {
          connection,
          sessionAccessUrl: config.sessionAccessUrl,
          fiscal: {
            migrationState: config.fiscalMigrationState,
            panelUrl: config.fiscalPanelUrl,
          },
        });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/connection/status') {
        json(response, 200, {
          connection: readConnectionSnapshot(config.statusPath),
          sessionAccessUrl: config.sessionAccessUrl,
        });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/connection/logout') {
        try {
          const result = await postLocalJson({ host: config.qrAdminHost, port: config.qrAdminPort, pathname: '/logout' });
          json(response, 200, { ok: result.ok !== false, warning: result.warning || null });
        } catch (error) {
          json(response, 502, { error: error.message });
        }
        return;
      }

      json(response, 404, { error: 'Rota não encontrada.' });
      return;
    }

    serveStatic(config.publicRoot, url.pathname, response);
  });

  server.on('error', (error) => {
    console.warn(`[PAINEL] não foi possível iniciar em ${config.host}:${config.port}: ${error.message}`);
  });

  server.listen(config.port, config.host, () => {
    console.log(`[PAINEL] unificado disponível em http://${config.host}:${config.port}`);
    console.log('[PAINEL] módulos iniciais: visão geral e conexão do bot');
  });

  return server;
}

module.exports = {
  createPanelConfig,
  readConnectionSnapshot,
  startUnifiedPanelServer,
};
