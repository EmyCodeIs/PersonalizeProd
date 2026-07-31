'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

const host = String(process.env.PANEL_PREVIEW_HOST || '127.0.0.1');
const port = Math.max(1, Number(process.env.PANEL_PREVIEW_PORT || 4173));
const publicRoot = path.resolve(process.cwd(), 'public', 'panel');

function qrDataUri() {
  const cells = 29;
  const size = 290;
  const cell = size / cells;
  const blocks = [];
  const finder = (x, y) => {
    blocks.push(`<rect x="${x * cell}" y="${y * cell}" width="${7 * cell}" height="${7 * cell}" rx="2" fill="#173334"/>`);
    blocks.push(`<rect x="${(x + 1) * cell}" y="${(y + 1) * cell}" width="${5 * cell}" height="${5 * cell}" fill="#fff"/>`);
    blocks.push(`<rect x="${(x + 2) * cell}" y="${(y + 2) * cell}" width="${3 * cell}" height="${3 * cell}" fill="#173334"/>`);
  };
  finder(1, 1); finder(21, 1); finder(1, 21);
  for (let y = 1; y < 28; y += 1) {
    for (let x = 1; x < 28; x += 1) {
      const inFinder = (x < 9 && y < 9) || (x > 19 && y < 9) || (x < 9 && y > 19);
      if (inFinder) continue;
      if (((x * 7 + y * 11 + x * y) % 5) < 2) blocks.push(`<rect x="${x * cell}" y="${y * cell}" width="${cell}" height="${cell}" fill="#173334"/>`);
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}"><rect width="100%" height="100%" fill="#fff"/>${blocks.join('')}</svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

const connection = {
  status: 'qr',
  connectionState: 'PAIRING',
  attempts: 2,
  pairingCode: 'PREV-2026',
  imageSrc: qrDataUri(),
  message: 'QR demonstrativo para avaliação do frontend.',
  updatedAt: new Date().toISOString(),
  lastConnectedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
};

function json(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
  response.end(body);
}

function mime(filePath) {
  return ({ '.html':'text/html; charset=utf-8', '.js':'application/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.svg':'image/svg+xml', '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.webp':'image/webp' }[path.extname(filePath).toLowerCase()] || 'application/octet-stream');
}

function serveStatic(response, pathname) {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const target = path.resolve(publicRoot, relative);
  const filePath = target.startsWith(publicRoot) && fs.existsSync(target) && fs.statSync(target).isFile() ? target : path.join(publicRoot, 'index.html');
  const stats = fs.statSync(filePath);
  response.writeHead(200, { 'Content-Type': mime(filePath), 'Content-Length': stats.size, 'Cache-Control': 'no-store' });
  fs.createReadStream(filePath).pipe(response);
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url || '/', `http://${request.headers.host || `${host}:${port}`}`);

  if (request.method === 'GET' && url.pathname === '/health') return json(response, 200, { ok: true, mode: 'frontend-preview' });
  if (request.method === 'GET' && url.pathname === '/api/auth/me') return json(response, 200, { user: { name: process.env.PANEL_PREVIEW_USER || 'Emilly Santos', role: 'admin' } });
  if (request.method === 'POST' && url.pathname === '/api/auth/login') return json(response, 200, { user: { name: process.env.PANEL_PREVIEW_USER || 'Emilly Santos', role: 'admin' } });
  if (request.method === 'POST' && url.pathname === '/api/auth/logout') return json(response, 200, { ok: true });
  if (request.method === 'GET' && url.pathname === '/api/panel/overview') return json(response, 200, { connection, sessionAccessUrl: '', fiscal: { migrationState: 'integrado', panelUrl: '/fiscal/' }, preview: true });
  if (request.method === 'GET' && url.pathname === '/api/connection/status') return json(response, 200, { connection, sessionAccessUrl: '', preview: true });
  if (request.method === 'POST' && url.pathname === '/api/connection/logout') return json(response, 200, { ok: true, preview: true, warning: 'Nenhuma sessão real foi alterada.' });
  if (url.pathname.startsWith('/api/')) return json(response, 404, { error: 'Rota não disponível no modo de prévia.' });

  serveStatic(response, url.pathname);
});

server.listen(port, host, () => {
  console.log('');
  console.log('╭────────────────────────────────────────────────────────╮');
  console.log('│  PERSONALIZE · PRÉVIA DO FRONTEND                      │');
  console.log('├────────────────────────────────────────────────────────┤');
  console.log(`│  http://${host}:${port}/?preview=1${' '.repeat(Math.max(0, 27 - String(host).length - String(port).length))}│`);
  console.log('│  Bot, Chrome, WPPConnect e Focus não foram iniciados.   │');
  console.log('╰────────────────────────────────────────────────────────╯');
  console.log('');
});
