'use strict';

let syncingEnvironmentBadge = false;

async function syncEnvironmentBadge() {
  if (syncingEnvironmentBadge) return;
  const badge = document.querySelector('.environment-badge');
  if (!badge) return;

  syncingEnvironmentBadge = true;
  try {
    const response = await fetch('/fiscal/api/health', { cache: 'no-store' });
    if (!response.ok) return;
    const status = await response.json();
    badge.textContent = status.demoMode
      ? 'Demonstração'
      : status.environment === 'producao' ? 'PRODUÇÃO REAL' : 'Homologação real';
  } catch {
    // Mantém o texto atual quando o status do servidor não puder ser consultado.
  } finally {
    syncingEnvironmentBadge = false;
  }
}

const observer = new MutationObserver(() => void syncEnvironmentBadge());
observer.observe(document.documentElement, { childList: true, subtree: true });
window.addEventListener('hashchange', () => void syncEnvironmentBadge());
window.addEventListener('focus', () => void syncEnvironmentBadge());
document.addEventListener('DOMContentLoaded', () => void syncEnvironmentBadge());
