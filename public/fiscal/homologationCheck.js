'use strict';

(() => {
  const COMPANY_CNPJ = '18342858000108';
  let running = false;

  async function request(url) {
    const response = await fetch(url, {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    });
    const type = response.headers.get('content-type') || '';
    const payload = type.includes('application/json') ? await response.json() : { error: await response.text() };
    if (!response.ok) {
      const error = new Error(payload.error || `A Focus respondeu HTTP ${response.status}.`);
      error.status = response.status;
      error.payload = payload;
      throw error;
    }
    return payload;
  }

  function setResult(container, message, type = '') {
    container.textContent = message;
    container.className = `focus-check-result ${type}`.trim();
  }

  async function runCheck(button, result) {
    if (running) return;
    running = true;
    button.disabled = true;
    button.textContent = 'Testando...';
    setResult(result, 'Conferindo ambiente e autenticação...');

    try {
      const health = await request('/fiscal/api/health');
      if (health.demoMode) {
        throw new Error('Ainda está em demonstração. Defina DEMO_MODE=false e reinicie o sistema.');
      }
      if (health.environment !== 'homologacao') {
        throw new Error('O teste seguro só funciona com FOCUS_ENVIRONMENT=homologacao.');
      }
      if (!health.tokenConfigured) {
        throw new Error('Token de homologação da Focus não configurado.');
      }

      await request(`/fiscal/api/lookup/cnpj/${COMPANY_CNPJ}`);
      setResult(result, 'Focus homologação conectada e token aceito.', 'success');
    } catch (error) {
      setResult(result, error.message, 'error');
    } finally {
      running = false;
      button.disabled = false;
      button.textContent = 'Testar Focus';
    }
  }

  function install() {
    const topbar = document.querySelector('.topbar');
    if (!topbar || topbar.querySelector('[data-focus-check]')) return;

    const wrap = document.createElement('div');
    wrap.className = 'focus-check-wrap';
    wrap.dataset.focusCheck = 'true';

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'focus-check-button';
    button.textContent = 'Testar Focus';

    const result = document.createElement('span');
    result.className = 'focus-check-result';
    result.textContent = 'Teste real de homologação sem emitir nota.';

    button.addEventListener('click', () => runCheck(button, result));
    wrap.append(button, result);
    topbar.appendChild(wrap);
  }

  const observer = new MutationObserver(install);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener('DOMContentLoaded', install);
  install();
})();
