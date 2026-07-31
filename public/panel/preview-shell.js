'use strict';

(() => {
  const app = document.querySelector('#app');
  const toast = document.querySelector('#toast');
  if (!app) return;

  app.innerHTML = `<div class="app-shell">
    <aside class="sidebar">
      <div class="sidebar-brand"><span class="brand-logo" aria-label="Personalize Seu Ambiente"></span><small>Painel operacional</small></div>
      <nav class="sidebar-nav" aria-label="Navegação principal"></nav>
      <div class="sidebar-footer">
        <div class="user-chip" aria-label="Emilly Santos, Administrador">
          <div class="avatar">ES</div>
          <div><strong>Emilly Santos</strong><small>Administrador</small></div>
        </div>
        <button class="nav-link" type="button" data-preview-exit><span class="nav-icon">↪</span>Sair</button>
      </div>
    </aside>
    <main class="main">
      <header class="topbar"><h1>Visão geral</h1><div class="topbar-actions"><span class="runtime-badge">Prévia visual</span></div></header>
      <div class="content"></div>
    </main>
    <nav class="mobile-nav" aria-label="Navegação móvel"></nav>
  </div>`;

  window.notify = (message, type = '') => {
    if (!toast) return;
    toast.textContent = message;
    toast.className = `toast show ${type}`;
    clearTimeout(window.notify.timer);
    window.notify.timer = setTimeout(() => { toast.className = 'toast'; }, 3600);
  };

  document.querySelector('[data-preview-exit]')?.addEventListener('click', () => {
    window.notify('Esta é apenas a prévia visual. Nenhuma sessão foi encerrada.');
  });
})();
