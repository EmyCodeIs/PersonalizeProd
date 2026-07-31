'use strict';

(function installOrganizedSidebarNavigation() {
  const app = document.querySelector('#app');
  if (!app) return;

  let scheduled = false;
  let fiscalRequestInFlight = null;

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[char]));
  }

  function icon(name) {
    const paths = {
      overview: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
      leads: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
      whatsapp: '<path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z"/><path d="M8 9h8M8 13h5"/>',
      fiscalConnection: '<path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/><path d="M18 8v3a6 6 0 0 1-12 0V8z"/><path d="M8 8h8"/>',
      fiscal: '<path d="M6 2h9l3 3v17H6z"/><path d="M14 2v5h5"/><path d="M9 12h6M9 16h6"/>',
      logout: '<path d="M10 17l5-5-5-5"/><path d="M15 12H3"/><path d="M21 19V5a2 2 0 0 0-2-2h-6"/>',
    };

    return `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths[name] || paths.overview}</svg>`;
  }

  function currentRoute() {
    const hash = location.hash || '#/';
    if (hash.startsWith('#/leads')) return 'leads';
    if (hash.startsWith('#/integracao-fiscal')) return 'fiscalConnection';
    if (hash.startsWith('#/conexao')) return 'whatsapp';
    if (hash.startsWith('#/notas')) return 'fiscal';
    return 'overview';
  }

  function navLink(hash, label, route, iconName) {
    const active = currentRoute() === route ? ' active' : '';
    return `<a class="nav-link${active}" href="${hash}"><span class="nav-icon">${icon(iconName)}</span><span>${escapeHtml(label)}</span></a>`;
  }

  function navGroup(label, content) {
    return `<section class="nav-group"><div class="nav-group-label">${escapeHtml(label)}</div><div class="nav-group-links">${content}</div></section>`;
  }

  function renderNavigation() {
    const sidebarNav = document.querySelector('.sidebar-nav');
    if (!sidebarNav) return;

    const signature = currentRoute();
    if (sidebarNav.dataset.structure === signature) return;

    sidebarNav.dataset.structure = signature;
    sidebarNav.innerHTML = [
      navGroup('Geral', navLink('#/', 'Visão geral', 'overview', 'overview')),
      navGroup('Atendimento', navLink('#/leads', 'Leads', 'leads', 'leads')),
      navGroup('Conexões', [
        navLink('#/conexao', 'Bot do WhatsApp', 'whatsapp', 'whatsapp'),
        navLink('#/integracao-fiscal', 'Integração fiscal', 'fiscalConnection', 'fiscalConnection'),
      ].join('')),
      navGroup('Fiscal', navLink('#/notas', 'Notas fiscais', 'fiscal', 'fiscal')),
    ].join('');

    const logoutIcon = document.querySelector('[data-action="logout"] .nav-icon');
    if (logoutIcon) logoutIcon.innerHTML = icon('logout');

    const mobileNav = document.querySelector('.mobile-nav');
    if (mobileNav) {
      mobileNav.innerHTML = [
        ['#/', 'Início', 'overview', 'overview'],
        ['#/leads', 'Leads', 'leads', 'leads'],
        ['#/conexao', 'Bot', 'whatsapp', 'whatsapp'],
        ['#/integracao-fiscal', 'Integração', 'fiscalConnection', 'fiscalConnection'],
        ['#/notas', 'Notas', 'fiscal', 'fiscal'],
      ].map(([hash, label, route, iconName]) => `<a class="${currentRoute() === route ? 'active' : ''}" href="${hash}"><span>${icon(iconName)}</span><small>${label}</small></a>`).join('');
    }
  }

  function leadsMarkup() {
    return `<div class="hero-row module-page-heading">
      <div><span class="module-eyebrow">Atendimento</span><h2>Leads</h2><p>Acompanhe os contatos que entraram no atendimento e organize os próximos passos comerciais.</p></div>
    </div>
    <section class="grid metrics leads-summary">
      <article class="metric"><div class="metric-label">Leads recebidos</div><div class="metric-value">—</div><div class="metric-foot">Aguardando integração com o relatório de leads</div></article>
      <article class="metric blue"><div class="metric-label">Aguardando retorno</div><div class="metric-value">—</div><div class="metric-foot">Clientes sem continuidade no atendimento</div></article>
      <article class="metric red"><div class="metric-label">Com vendedor</div><div class="metric-value">—</div><div class="metric-foot">Contatos em handoff ou atendimento manual</div></article>
    </section>
    <section class="card module-empty-card">
      <div class="module-empty-icon">${icon('leads')}</div>
      <div><h3>Área preparada para o módulo de leads</h3><p>Esta tela será ligada ao relatório de clientes parados, histórico completo da conversa e responsáveis pelo atendimento. Nenhum número fictício é exibido enquanto a fonte de dados ainda não estiver conectada.</p></div>
    </section>`;
  }

  function fiscalConnectionMarkup(data = {}) {
    const fiscal = data.fiscal || {};
    const integrated = (fiscal.migrationState || 'integrado') === 'integrado';
    const connection = data.connection || {};

    return `<div class="hero-row module-page-heading">
      <div><span class="module-eyebrow">Conexões</span><h2>Integração fiscal</h2><p>Consulte separadamente o estado da comunicação fiscal e acesse a emissão de notas.</p></div>
    </div>
    <section class="module-status-card ${integrated ? 'is-ready' : 'is-pending'}">
      <div class="module-status-icon">${icon('fiscalConnection')}</div>
      <div class="module-status-copy"><span>${integrated ? 'Integração disponível' : 'Integração em preparação'}</span><h3>${integrated ? 'Módulo fiscal conectado ao painel' : 'Configuração fiscal pendente'}</h3><p>Credenciais e tokens permanecem protegidos no servidor e não são exibidos nesta tela.</p></div>
      <span class="status-pill ${integrated ? 'status-connected' : 'status-waiting'}">${integrated ? 'Integrado' : 'Pendente'}</span>
    </section>
    <section class="grid card-grid module-info-grid">
      <article class="card">
        <div class="card-header"><div><h3>Estado da integração</h3><p>Separado da conexão do WhatsApp.</p></div></div>
        <div class="definition-list">
          <div class="definition-item"><small>Módulo</small><strong>Notas fiscais</strong></div>
          <div class="definition-item"><small>Disponibilidade</small><strong>${integrated ? 'Disponível' : 'Em configuração'}</strong></div>
          <div class="definition-item"><small>Painel fiscal</small><strong>${fiscal.panelUrl ? 'Rota configurada' : 'Sem rota informada'}</strong></div>
          <div class="definition-item"><small>Bot do WhatsApp</small><strong>${escapeHtml(connection.status || 'independente')}</strong></div>
        </div>
      </article>
      <article class="card module-action-card">
        <div class="module-action-icon">${icon('fiscal')}</div>
        <h3>Emitir e consultar notas</h3>
        <p>A emissão, os rascunhos, PDFs, XMLs e o histórico permanecem concentrados no módulo de notas fiscais.</p>
        <a class="button primary" href="#/notas">Abrir notas fiscais</a>
      </article>
    </section>`;
  }

  function renderCustomRoute() {
    const route = currentRoute();
    if (route !== 'leads' && route !== 'fiscalConnection') return;

    if (typeof window.stopPolling === 'function') window.stopPolling();

    const content = document.querySelector('.content');
    const title = document.querySelector('.topbar h1');
    if (!content || !title) return;

    if (content.dataset.customRoute === route) return;
    content.dataset.customRoute = route;

    if (route === 'leads') {
      title.textContent = 'Leads';
      content.innerHTML = leadsMarkup();
      return;
    }

    title.textContent = 'Integração fiscal';
    content.innerHTML = '<section class="card module-loading">Carregando estado da integração fiscal…</section>';

    if (!fiscalRequestInFlight) {
      fiscalRequestInFlight = fetch('/api/panel/overview', { credentials: 'same-origin', headers: { Accept: 'application/json' } })
        .then((response) => response.ok ? response.json() : {})
        .catch(() => ({}))
        .finally(() => { fiscalRequestInFlight = null; });
    }

    fiscalRequestInFlight.then((data) => {
      if (currentRoute() !== 'fiscalConnection') return;
      const freshContent = document.querySelector('.content');
      if (!freshContent) return;
      freshContent.innerHTML = fiscalConnectionMarkup(data);
      freshContent.dataset.customRoute = route;
    });
  }

  function enhance() {
    scheduled = false;
    renderNavigation();
    renderCustomRoute();
  }

  function scheduleEnhance() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(enhance);
  }

  const observer = new MutationObserver(scheduleEnhance);
  observer.observe(app, { childList: true, subtree: true });
  window.addEventListener('hashchange', scheduleEnhance);

  scheduleEnhance();
})();
