'use strict';

const app = document.querySelector('#app');
const toast = document.querySelector('#toast');
const state = {
  user: null,
  overview: null,
  pollTimer: null,
};

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[char]));

function formatDate(value) {
  if (!value) return 'Ainda não registrada';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString('pt-BR');
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const type = response.headers.get('content-type') || '';
  const payload = type.includes('application/json') ? await response.json() : await response.text();
  if (!response.ok) {
    const error = new Error(payload?.error || 'Não foi possível concluir a operação.');
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

function notify(message, type = '') {
  toast.textContent = message;
  toast.className = `toast show ${type}`;
  clearTimeout(notify.timer);
  notify.timer = setTimeout(() => { toast.className = 'toast'; }, 3600);
}

function stopPolling() {
  clearInterval(state.pollTimer);
  state.pollTimer = null;
}

function statusMeta(connection = {}) {
  const status = String(connection.status || '').toLowerCase();
  const technical = String(connection.connectionState || '').toUpperCase();
  if (status === 'connected') return { className: 'status-connected', label: 'Conectado', title: 'WhatsApp conectado', description: 'A sessão está pronta para receber e responder mensagens.' };
  if (status === 'qr') return { className: 'status-qr', label: 'Aguardando QR', title: 'Conecte o WhatsApp', description: 'Leia o QR Code com o WhatsApp Business para iniciar a sessão.' };
  if (status === 'error') return { className: 'status-error', label: 'Com erro', title: 'Falha ao ler a conexão', description: connection.message || 'Não foi possível consultar o estado da sessão.' };
  if (/DISCONNECT|UNPAIRED|CONFLICT|PHONE/i.test(technical)) return { className: 'status-disconnected', label: 'Desconectado', title: 'Sessão desconectada', description: connection.message || 'A sessão precisa ser conectada novamente.' };
  return { className: 'status-waiting', label: 'Aguardando', title: 'Aguardando o WhatsApp', description: connection.message || 'O bot ainda está preparando a sessão.' };
}

function routeName() {
  const hash = location.hash || '#/';
  if (hash.startsWith('#/conexao')) return 'connection';
  if (hash.startsWith('#/notas')) return 'fiscal';
  return 'overview';
}

function icon(name) {
  return ({ overview: '⌂', connection: '◉', fiscal: '▤', logout: '↪' }[name] || '•');
}

function shell(content, title) {
  const route = routeName();
  const nav = (hash, label, name) => `<a class="nav-link ${route === name ? 'active' : ''}" href="${hash}"><span class="nav-icon">${icon(name)}</span>${label}</a>`;
  return `<div class="app-shell">
    <aside class="sidebar">
      <div class="sidebar-brand"><span class="brand-logo" aria-label="Personalize Seu Ambiente"></span><small>Painel operacional</small></div>
      <nav class="sidebar-nav">
        ${nav('#/', 'Visão geral', 'overview')}
        ${nav('#/conexao', 'Conexão do bot', 'connection')}
        ${nav('#/notas', 'Notas fiscais', 'fiscal')}
      </nav>
      <div class="sidebar-footer">
        <div class="user-chip"><div class="avatar">P</div><div><strong>Personalize</strong><small>${escapeHtml(state.user?.email || '')}</small></div></div>
        <button class="nav-link" data-action="logout"><span class="nav-icon">${icon('logout')}</span>Sair</button>
      </div>
    </aside>
    <main class="main">
      <header class="topbar"><h1>${escapeHtml(title)}</h1><div class="topbar-actions"><span class="runtime-badge">Painel unificado</span></div></header>
      <div class="content">${content}</div>
    </main>
    <nav class="mobile-nav">
      <a class="${route === 'overview' ? 'active' : ''}" href="#/">Início</a>
      <a class="${route === 'connection' ? 'active' : ''}" href="#/conexao">Conexão</a>
      <a class="${route === 'fiscal' ? 'active' : ''}" href="#/notas">Notas</a>
    </nav>
  </div>`;
}

function loginView() {
  stopPolling();
  app.innerHTML = `<div class="login-shell">
    <section class="login-brand">
      <div class="login-brand-head"><span class="brand-logo" aria-label="Personalize Seu Ambiente"></span><small>Painel operacional</small></div>
      <div class="login-copy">
        <h1>Tudo da Personalize em um só lugar.</h1>
        <p>Acompanhe a conexão do atendimento e organize a emissão de notas fiscais em uma interface única.</p>
        <div class="login-benefits">
          <div class="login-benefit"><span>✓</span>Status e reconexão do bot</div>
          <div class="login-benefit"><span>✓</span>Controle do WhatsApp compartilhado</div>
          <div class="login-benefit"><span>✓</span>Módulo fiscal integrado com segurança</div>
        </div>
      </div>
      <small class="login-brand-foot">Personalize Seu Ambiente</small>
    </section>
    <section class="login-form-wrap">
      <form class="login-card" id="login-form">
        <h2>Bem-vinda</h2>
        <p>Entre com sua conta para acessar o painel da Personalize.</p>
        <div class="field"><label for="email">E-mail</label><input id="email" name="email" type="email" value="contato@personalizeseuambiente.com.br" autocomplete="username" required></div>
        <div class="field"><label for="password">Senha</label><input id="password" name="password" type="password" autocomplete="current-password" required autofocus></div>
        <button class="button primary full" type="submit">Entrar no painel</button>
        <div class="login-note">O painel não interfere no atendimento quando estiver fechado.</div>
      </form>
    </section>
  </div>`;

  document.querySelector('#login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = event.currentTarget.querySelector('button');
    button.disabled = true;
    try {
      const data = Object.fromEntries(new FormData(event.currentTarget));
      const result = await api('/api/auth/login', { method: 'POST', body: JSON.stringify(data) });
      state.user = result.user;
      location.hash = '#/';
      await route();
    } catch (error) {
      notify(error.message, 'error');
    } finally {
      button.disabled = false;
    }
  });
}

function bindShell() {
  document.querySelector('[data-action="logout"]')?.addEventListener('click', async () => {
    try { await api('/api/auth/logout', { method: 'POST', body: '{}' }); } catch (_) {}
    state.user = null;
    loginView();
  });
}

function overviewMarkup(data) {
  const connection = data.connection || {};
  const meta = statusMeta(connection);
  const fiscalState = data.fiscal?.migrationState || 'integrado';
  const fiscalReady = fiscalState === 'integrado';
  return `<div class="hero-row"><div><h2>Olá, Personalize 👋</h2><p>Confira os módulos operacionais e acesse rapidamente o que precisa de atenção.</p></div></div>
    <section class="grid metrics">
      <article class="metric"><div class="metric-label">Conexão do bot</div><div class="metric-value">${escapeHtml(meta.label)}</div><div class="metric-foot">${escapeHtml(connection.connectionState || 'Sem sinal técnico')}</div></article>
      <article class="metric blue"><div class="metric-label">Última atualização</div><div class="metric-value" style="font-size:19px">${escapeHtml(formatDate(connection.updatedAt))}</div><div class="metric-foot">Status publicado pelo WPPConnect</div></article>
      <article class="metric red"><div class="metric-label">Módulo fiscal</div><div class="metric-value">${fiscalReady ? 'Integrado' : 'Migrando'}</div><div class="metric-foot">Emissão, documentos e histórico no mesmo painel</div></article>
    </section>
    <section class="grid card-grid">
      <article class="card">
        <div class="card-header"><div><h3>Módulos do painel</h3><p>A mesma entrada para operação e administração.</p></div></div>
        <div class="module-list">
          <a class="module-card" href="#/conexao"><div class="module-icon">◉</div><div><strong>Conexão do bot</strong><p>Veja o status, QR Code e acesse o mesmo Chrome usado pelo atendimento.</p></div><span class="module-state">${escapeHtml(meta.label)}</span></a>
          <a class="module-card" href="#/notas"><div class="module-icon blue">▤</div><div><strong>Notas fiscais</strong><p>Emissão, acompanhamento, PDF, XML e histórico de NFS-e.</p></div><span class="module-state">${fiscalReady ? 'Disponível' : 'Em migração'}</span></a>
        </div>
      </article>
      <article class="card">
        <div class="card-header"><div><h3>Estado da sessão</h3><p>Leitura direta do bot em execução.</p></div></div>
        <div class="status-line"><span class="status-pill ${meta.className}">${escapeHtml(meta.label)}</span></div>
        <div class="definition-list">
          <div class="definition-item"><small>Estado técnico</small><strong>${escapeHtml(connection.connectionState || 'SEM SINAL')}</strong></div>
          <div class="definition-item"><small>Última conexão estável</small><strong>${escapeHtml(formatDate(connection.lastConnectedAt))}</strong></div>
        </div>
      </article>
    </section>`;
}

async function overviewView() {
  const data = await api('/api/panel/overview');
  state.overview = data;
  app.innerHTML = shell(overviewMarkup(data), 'Visão geral');
  bindShell();
  stopPolling();
  state.pollTimer = setInterval(async () => {
    if (routeName() !== 'overview') return;
    try {
      const fresh = await api('/api/panel/overview');
      state.overview = fresh;
      app.innerHTML = shell(overviewMarkup(fresh), 'Visão geral');
      bindShell();
    } catch (_) {}
  }, 8000);
}

function connectionMarkup(data) {
  const connection = data.connection || {};
  const meta = statusMeta(connection);
  const viewerButton = data.sessionAccessUrl
    ? `<a class="button primary" href="${escapeHtml(data.sessionAccessUrl)}" target="_blank" rel="noopener">Abrir controle do WhatsApp</a>`
    : '<button class="button secondary" disabled>Controle remoto não configurado</button>';
  const qr = connection.imageSrc
    ? `<img src="${escapeHtml(connection.imageSrc)}" alt="QR Code do WhatsApp"><p>WhatsApp Business → Aparelhos conectados → Conectar aparelho</p>${connection.pairingCode ? `<div class="pairing-code">${escapeHtml(connection.pairingCode)}</div>` : ''}`
    : `<div class="empty-state"><strong>${connection.status === 'connected' ? 'Nenhum QR necessário' : 'QR ainda não disponível'}</strong><p>${connection.status === 'connected' ? 'A sessão já está conectada.' : 'O QR aparecerá automaticamente quando o WPPConnect solicitar uma nova conexão.'}</p></div>`;
  return `<div class="hero-row"><div><h2>Conexão do bot</h2><p>Acompanhe a sessão do WhatsApp e acesse o mesmo navegador utilizado pelo WPPConnect.</p></div></div>
    <section class="connection-layout">
      <article class="connection-hero">
        <span class="status-pill ${meta.className}">${escapeHtml(meta.label)}</span>
        <h3>${escapeHtml(meta.title)}</h3>
        <p>${escapeHtml(meta.description)}</p>
        <div class="definition-list">
          <div class="definition-item"><small>Estado técnico</small><strong>${escapeHtml(connection.connectionState || 'SEM SINAL')}</strong></div>
          <div class="definition-item"><small>Atualizado em</small><strong>${escapeHtml(formatDate(connection.updatedAt))}</strong></div>
          <div class="definition-item"><small>Última conexão estável</small><strong>${escapeHtml(formatDate(connection.lastConnectedAt))}</strong></div>
          <div class="definition-item"><small>Tentativa de QR</small><strong>${escapeHtml(connection.attempts || 0)}</strong></div>
        </div>
        <div class="connection-actions">${viewerButton}<button class="button danger" data-action="disconnect-whatsapp">Desconectar sessão</button></div>
      </article>
      <article class="qr-card">${qr}</article>
    </section>`;
}

async function connectionView() {
  const data = await api('/api/connection/status');
  app.innerHTML = shell(connectionMarkup(data), 'Conexão do bot');
  bindShell();
  bindConnectionActions();
  stopPolling();
  state.pollTimer = setInterval(async () => {
    if (routeName() !== 'connection') return;
    try {
      const fresh = await api('/api/connection/status');
      app.innerHTML = shell(connectionMarkup(fresh), 'Conexão do bot');
      bindShell();
      bindConnectionActions();
    } catch (_) {}
  }, 5000);
}

function bindConnectionActions() {
  document.querySelector('[data-action="disconnect-whatsapp"]')?.addEventListener('click', async (event) => {
    if (!window.confirm('Desconectar o WhatsApp desta sessão? Será necessário conectar novamente.')) return;
    event.currentTarget.disabled = true;
    try {
      await api('/api/connection/logout', { method: 'POST', body: '{}' });
      notify('Sessão desconectada. Aguarde o novo QR Code.');
      setTimeout(() => route(), 1200);
    } catch (error) {
      notify(error.message, 'error');
      event.currentTarget.disabled = false;
    }
  });
}

async function fiscalView() {
  app.innerHTML = shell(`<section class="fiscal-frame-card">
    <iframe class="fiscal-frame" src="/fiscal/?embedded=1" title="Emissão e gestão de notas fiscais" loading="eager"></iframe>
  </section>`, 'Notas fiscais');
  bindShell();
  stopPolling();
}
async function route() {
  stopPolling();
  if (!state.user) return loginView();
  try {
    const current = routeName();
    if (current === 'connection') return await connectionView();
    if (current === 'fiscal') return await fiscalView();
    return await overviewView();
  } catch (error) {
    if (error.status === 401) {
      state.user = null;
      return loginView();
    }
    app.innerHTML = shell(`<section class="card"><div class="empty-state"><strong>Não foi possível carregar o painel</strong><p>${escapeHtml(error.message)}</p></div></section>`, 'Painel');
    bindShell();
    notify(error.message, 'error');
  }
}

window.addEventListener('hashchange', route);

(async function bootstrap() {
  try {
    const result = await api('/api/auth/me');
    state.user = result.user;
  } catch (_) {
    state.user = null;
  }
  await route();
})();
