'use strict';

(() => {
  const MODE_STORAGE_KEY = 'personalize.connection.mode';
  const APP_SELECTOR = '#app';
  const ENHANCED_ATTRIBUTE = 'data-connection-visual-ready';

  function normalize(value) {
    return String(value || '').trim();
  }

  function readMode() {
    try {
      return sessionStorage.getItem(MODE_STORAGE_KEY) === 'phone' ? 'phone' : 'qr';
    } catch (_) {
      return 'qr';
    }
  }

  function saveMode(mode) {
    try { sessionStorage.setItem(MODE_STORAGE_KEY, mode); } catch (_) {}
  }

  function readDefinition(root, expectedLabel) {
    const expected = expectedLabel.toLowerCase();
    for (const item of root.querySelectorAll('.definition-item')) {
      const label = normalize(item.querySelector('small')?.textContent).toLowerCase();
      if (label === expected) return normalize(item.querySelector('strong')?.textContent);
    }
    return '';
  }

  function stateKind(statusPill) {
    if (!statusPill) return 'waiting';
    if (statusPill.classList.contains('status-connected')) return 'connected';
    if (statusPill.classList.contains('status-disconnected')) return 'disconnected';
    if (statusPill.classList.contains('status-error')) return 'error';
    if (statusPill.classList.contains('status-qr')) return 'qr';
    return 'waiting';
  }

  function icon(name) {
    const icons = {
      qr: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3h7v7H3V3Zm2 2v3h3V5H5Zm9-2h7v7h-7V3Zm2 2v3h3V5h-3ZM3 14h7v7H3v-7Zm2 2v3h3v-3H5Zm9-2h2v2h-2v-2Zm3 0h4v2h-2v2h2v3h-2v-1h-2v-2h-2v3h-2v-5h2v2h2v-4Zm-3 3h2v2h-2v-2Z"/></svg>',
      phone: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7.2 2h3.1l1.4 5-2 1.7a15.5 15.5 0 0 0 5.6 5.6l1.7-2 5 1.4v3.1c0 2.3-1.9 4.2-4.2 4.2A15.8 15.8 0 0 1 3 6.2C3 3.9 4.9 2 7.2 2Z"/></svg>',
      refresh: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18.7 6.3A9 9 0 1 0 21 12h-2.5A6.5 6.5 0 1 1 16.9 7.8L13 11.7h8V3.8l-2.3 2.5Z"/></svg>',
      check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9.2 16.6-4.4-4.4 1.8-1.8 2.6 2.6 7.9-7.9 1.8 1.8-9.7 9.7Z"/></svg>',
      arrow: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 18 6-6-6-6 1.8-1.8L18.6 12l-7.8 7.8L9 18Z"/></svg>',
    };
    return icons[name] || '';
  }

  function enhanceConnectionLayout(layout) {
    if (!layout || layout.hasAttribute(ENHANCED_ATTRIBUTE)) return;

    const originalHero = layout.querySelector('.connection-hero');
    const originalQrCard = layout.querySelector('.qr-card');
    if (!originalHero || !originalQrCard) return;

    const statusPill = originalHero.querySelector('.status-pill');
    const viewerAction = originalHero.querySelector('.connection-actions a, .connection-actions button.secondary');
    const disconnectAction = originalHero.querySelector('[data-action="disconnect-whatsapp"]');
    const qrImage = originalQrCard.querySelector('img');
    const pairingCode = normalize(originalQrCard.querySelector('.pairing-code')?.textContent);

    const status = stateKind(statusPill);
    const statusLabel = normalize(statusPill?.textContent) || 'Aguardando';
    const technicalState = readDefinition(originalHero, 'Estado técnico') || 'SEM SINAL';
    const updatedAt = readDefinition(originalHero, 'Atualizado em') || 'Ainda não registrada';
    const lastConnectedAt = readDefinition(originalHero, 'Última conexão estável') || 'Ainda não registrada';
    const attemptText = readDefinition(originalHero, 'Tentativa de QR') || '0';
    const attemptNumber = Math.max(0, Number.parseInt(attemptText, 10) || 0);

    statusPill?.remove();
    viewerAction?.remove();
    disconnectAction?.remove();
    qrImage?.remove();

    layout.className = 'connection-whatsapp';
    layout.setAttribute(ENHANCED_ATTRIBUTE, 'true');
    layout.dataset.connectionState = status;
    layout.dataset.connectionMode = readMode();

    layout.innerHTML = `
      <section class="connection-whatsapp-card">
        <header class="connection-whatsapp-header">
          <div>
            <span class="connection-whatsapp-eyebrow">Sessão do atendimento</span>
            <h3>Conecte o WhatsApp Business</h3>
            <p>Use o método de conexão mais confortável para iniciar ou recuperar a sessão do bot.</p>
          </div>
          <div class="connection-status-slot" aria-label="Status atual"></div>
        </header>

        <nav class="connection-method-tabs" aria-label="Método de conexão">
          <button type="button" class="connection-method-tab" data-connection-mode="qr" aria-selected="false">
            <span class="connection-method-icon">${icon('qr')}</span>
            QR Code
          </button>
          <button type="button" class="connection-method-tab" data-connection-mode="phone" aria-selected="false">
            <span class="connection-method-icon">${icon('phone')}</span>
            Número de telefone
          </button>
        </nav>

        <div class="connection-method-panel" data-connection-panel="qr">
          <div class="connection-instructions">
            <span class="connection-section-label">Escaneie para entrar</span>
            <h4>Conecte pelo QR Code</h4>
            <ol class="connection-steps">
              <li><span>1</span><p>Abra o <strong>WhatsApp Business</strong> no celular usado pela operação.</p></li>
              <li><span>2</span><p>Acesse <strong>Aparelhos conectados</strong> e toque em <strong>Conectar um aparelho</strong>.</p></li>
              <li><span>3</span><p>Aponte a câmera para o código exibido ao lado e aguarde a confirmação.</p></li>
            </ol>
            <div class="connection-help-note">O QR é renovado automaticamente pelo WPPConnect durante as tentativas de autenticação.</div>
          </div>

          <div class="connection-qr-stage">
            <div class="connection-qr-content" data-qr-state="active">
              <div class="connection-qr-code"></div>
              <div class="connection-attempt-badge">Tentativa atual: <strong>${attemptNumber || 1}</strong></div>
              <p>Mantenha esta página aberta enquanto realiza a leitura.</p>
            </div>

            <div class="connection-qr-content" data-qr-state="refresh">
              <button type="button" class="connection-refresh-control" data-action="refresh-connection" aria-label="Verificar novo QR Code">
                <span>${icon('refresh')}</span>
              </button>
              <h5>QR Code indisponível</h5>
              <p>O código pode ter expirado ou o WhatsApp ainda está preparando uma nova tentativa.</p>
              <button type="button" class="connection-refresh-button" data-action="refresh-connection">Verificar novo QR</button>
            </div>

            <div class="connection-qr-content" data-qr-state="connected">
              <div class="connection-success-icon">${icon('check')}</div>
              <h5>WhatsApp conectado</h5>
              <p>A sessão está ativa. Não é necessário ler um novo QR Code agora.</p>
            </div>
          </div>
        </div>

        <div class="connection-method-panel" data-connection-panel="phone">
          <div class="connection-phone-copy">
            <span class="connection-section-label">Entrar com número de telefone</span>
            <h4>Use um código de vínculo</h4>
            <p>Esta área prepara o segundo método de conexão mantendo o mesmo padrão visual do WhatsApp.</p>
            <div class="connection-phone-fields">
              <div class="connection-country-field"><span>🇧🇷</span><strong>Brasil</strong><span class="connection-field-arrow">⌄</span></div>
              <label class="connection-phone-field">
                <span>+55</span>
                <input type="tel" inputmode="numeric" autocomplete="tel" placeholder="(31) 99999-9999" aria-label="Número do WhatsApp Business">
              </label>
            </div>
            <button type="button" class="connection-phone-next" disabled>Avançar</button>
            <div class="connection-phone-caption">A integração funcional desse formulário será ligada ao WPPConnect em uma etapa separada.</div>
          </div>

          <div class="connection-pairing-stage">
            <span class="connection-section-label">Código disponível</span>
            <div class="connection-pairing-code" data-pairing-code>${pairingCode || 'Aguardando código'}</div>
            <p>${pairingCode ? 'Digite este código no WhatsApp Business para concluir o vínculo.' : 'O código aparecerá aqui quando o WPPConnect liberar essa forma de conexão.'}</p>
            <button type="button" class="connection-back-to-qr" data-connection-mode="qr">Conectar com o QR Code ${icon('arrow')}</button>
          </div>
        </div>

        <footer class="connection-whatsapp-footer">
          <div class="connection-runtime-summary">
            <div><span>Estado técnico</span><strong>${technicalState}</strong></div>
            <div><span>Atualizado em</span><strong>${updatedAt}</strong></div>
            <div><span>Última conexão</span><strong>${lastConnectedAt}</strong></div>
          </div>
          <div class="connection-toolbar-actions"></div>
        </footer>
      </section>
    `;

    const statusSlot = layout.querySelector('.connection-status-slot');
    if (statusPill && statusSlot) statusSlot.append(statusPill);
    else if (statusSlot) statusSlot.textContent = statusLabel;

    const qrSlot = layout.querySelector('.connection-qr-code');
    if (qrImage && qrSlot) {
      qrImage.classList.add('connection-qr-image');
      qrSlot.append(qrImage);
    }

    const toolbar = layout.querySelector('.connection-toolbar-actions');
    if (viewerAction && toolbar) toolbar.append(viewerAction);
    if (disconnectAction && toolbar) toolbar.append(disconnectAction);

    const visibleQrState = status === 'connected'
      ? 'connected'
      : qrImage
        ? 'active'
        : 'refresh';

    layout.querySelectorAll('[data-qr-state]').forEach((node) => {
      node.hidden = node.dataset.qrState !== visibleQrState;
    });

    function setMode(mode) {
      const nextMode = mode === 'phone' ? 'phone' : 'qr';
      layout.dataset.connectionMode = nextMode;
      saveMode(nextMode);
      layout.querySelectorAll('[data-connection-mode]').forEach((button) => {
        const selected = button.dataset.connectionMode === nextMode;
        button.setAttribute('aria-selected', selected ? 'true' : 'false');
      });
      layout.querySelectorAll('[data-connection-panel]').forEach((panel) => {
        panel.hidden = panel.dataset.connectionPanel !== nextMode;
      });
    }

    layout.querySelectorAll('[data-connection-mode]').forEach((button) => {
      button.addEventListener('click', () => setMode(button.dataset.connectionMode));
    });

    layout.querySelectorAll('[data-action="refresh-connection"]').forEach((button) => {
      button.addEventListener('click', () => {
        button.classList.add('is-refreshing');
        button.setAttribute('aria-busy', 'true');
        window.setTimeout(() => window.location.reload(), 320);
      });
    });

    setMode(readMode());
  }

  function enhanceVisibleConnection() {
    document.querySelectorAll(`.connection-layout:not([${ENHANCED_ATTRIBUTE}])`)
      .forEach(enhanceConnectionLayout);
  }

  const observer = new MutationObserver(enhanceVisibleConnection);

  function start() {
    const app = document.querySelector(APP_SELECTOR);
    if (!app) return;
    observer.observe(app, { childList: true, subtree: true });
    enhanceVisibleConnection();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
