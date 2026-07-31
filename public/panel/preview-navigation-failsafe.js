'use strict';

(() => {
  if (!window.__PERSONALIZE_FRONTEND_PREVIEW__) return;

  const ROUTE_LABELS = new Map([
    ['#/', 'Visão geral'],
    ['#/leads', 'Leads'],
    ['#/conexao', 'Conexão'],
    ['#/notas', 'Notas fiscais'],
    ['#/integracao-fiscal', 'Integração fiscal'],
    ['#/configuracoes', 'Configurações'],
  ]);

  let verificationTimer = null;

  function currentRoute() {
    return ROUTE_LABELS.has(window.location.hash) ? window.location.hash : '#/';
  }

  function contentIsVisible() {
    const content = document.querySelector('.content');
    if (!content) return false;
    const text = String(content.textContent || '').trim();
    const rect = content.getBoundingClientRect();
    return text.length > 20 && rect.width > 40 && rect.height > 20;
  }

  function showDiagnostic(route) {
    const content = document.querySelector('.content');
    const title = document.querySelector('.topbar h1');
    if (!content || contentIsVisible()) return;

    const label = ROUTE_LABELS.get(route) || 'Painel';
    if (title) title.textContent = label;
    content.dataset.previewRoute = `diagnostic:${route}`;
    content.innerHTML = `
      <section class="pw-card" style="max-width:760px;margin:24px auto">
        <span class="pw-status danger">Falha de renderização</span>
        <h2 style="margin:16px 0 8px">A tela ${label} não foi carregada</h2>
        <p style="color:#6c6c6c;line-height:1.6">A navegação recebeu o clique, mas o conteúdo visual não foi montado. Atualize esta branch e reinicie somente a prévia.</p>
        <pre style="overflow:auto;padding:12px;border-radius:10px;background:#f4f4f2">rota=${route}\nversão=frontend-preview-2026-07-31.2</pre>
        <button class="button primary" type="button" data-preview-retry>Carregar novamente</button>
      </section>`;

    content.querySelector('[data-preview-retry]')?.addEventListener('click', () => {
      window.location.reload();
    });
  }

  function verifyRoute(route = currentRoute()) {
    clearTimeout(verificationTimer);
    verificationTimer = window.setTimeout(() => {
      if (contentIsVisible()) return;

      // Reenvia o evento uma única vez para cobrir navegadores que não
      // notificaram o hashchange após a atualização do endereço.
      window.dispatchEvent(new HashChangeEvent('hashchange'));

      verificationTimer = window.setTimeout(() => showDiagnostic(route), 180);
    }, 120);
  }

  document.addEventListener('click', (event) => {
    const link = event.target.closest('.sidebar-nav a[href^="#/"], .mobile-nav a[href^="#/"], .pw-attention a[href^="#/"], .pw-shortcuts a[href^="#/"], a.button[href^="#/"]');
    if (!link) return;

    const nextRoute = link.getAttribute('href');
    if (!ROUTE_LABELS.has(nextRoute)) return;

    event.preventDefault();
    if (window.location.hash === nextRoute) {
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    } else {
      window.location.hash = nextRoute;
    }
    verifyRoute(nextRoute);
  });

  window.addEventListener('hashchange', () => verifyRoute(currentRoute()));
  window.addEventListener('load', () => verifyRoute(currentRoute()), { once: true });
})();
