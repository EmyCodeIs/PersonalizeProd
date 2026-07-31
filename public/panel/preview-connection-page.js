'use strict';

(() => {
  if (!window.__PERSONALIZE_FRONTEND_PREVIEW__) return;

  const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char]));

  function isConnectionRoute() {
    return (location.hash || '#/').startsWith('#/conexao');
  }

  async function renderConnection() {
    if (!isConnectionRoute()) return;
    const content = document.querySelector('.content');
    const title = document.querySelector('.topbar h1');
    if (!content || !title) return;

    title.textContent = 'Conexão';
    content.dataset.previewRoute = 'connection';
    content.innerHTML = '<section class="card module-loading">Preparando a prévia da conexão…</section>';

    let payload = {};
    try {
      const response = await fetch('/api/connection/status', { headers: { Accept: 'application/json' } });
      if (response.ok) payload = await response.json();
    } catch (_) {}

    if (!isConnectionRoute()) return;
    const connection = payload.connection || {};
    const image = connection.imageSrc
      ? `<img src="${escapeHtml(connection.imageSrc)}" alt="QR Code demonstrativo do WhatsApp">`
      : '';
    const pairing = connection.pairingCode
      ? `<div class="pairing-code">${escapeHtml(connection.pairingCode)}</div>`
      : '';

    content.innerHTML = `<div class="pw-banner">
      <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M10.3 2.8 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 2.8a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/></svg>
      <div><strong>Prévia de frontend</strong><p>O QR e o código são demonstrativos. Nenhuma sessão real está sendo conectada.</p></div>
    </div>
    <div class="hero-row"><div><h2>Conexão</h2><p>Experiência visual preparada para receber o estado real do WPPConnect na próxima etapa.</p></div></div>
    <section class="connection-layout">
      <article class="connection-hero">
        <span class="status-pill status-qr">Aguardando QR</span>
        <h3>Conecte o WhatsApp Business</h3>
        <p>Escolha o QR Code ou o código por número quando a integração funcional for ligada.</p>
        <div class="definition-list">
          <div class="definition-item"><small>Estado técnico</small><strong>${escapeHtml(connection.connectionState || 'PAIRING')}</strong></div>
          <div class="definition-item"><small>Atualizado em</small><strong>Agora · prévia</strong></div>
          <div class="definition-item"><small>Última conexão estável</small><strong>Não consultada</strong></div>
          <div class="definition-item"><small>Tentativa de QR</small><strong>${escapeHtml(connection.attempts || 1)}</strong></div>
        </div>
        <div class="connection-actions">
          <button class="button secondary" type="button" disabled>Controle remoto indisponível</button>
          <button class="button danger" type="button" data-action="disconnect-whatsapp">Desconectar sessão</button>
        </div>
      </article>
      <article class="qr-card">${image}<p>QR demonstrativo para avaliação do layout.</p>${pairing}</article>
    </section>`;

    document.querySelector('[data-action="disconnect-whatsapp"]')?.addEventListener('click', () => {
      window.notify?.('Ação visual: nenhuma sessão real foi desconectada.');
    });
  }

  window.addEventListener('hashchange', () => requestAnimationFrame(renderConnection));
  requestAnimationFrame(renderConnection);
})();
