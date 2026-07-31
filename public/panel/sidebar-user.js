'use strict';

(function installSidebarUserIdentity() {
  const app = document.querySelector('#app');
  if (!app) return;

  let currentUser = null;
  let requestInFlight = null;
  let lastRequestAt = 0;

  function roleLabel(role) {
    const normalized = String(role || '').trim().toLowerCase();
    if (normalized === 'admin') return 'Administrador';
    if (normalized === 'seller' || normalized === 'vendedor') return 'Vendedor';
    return 'Usuário do painel';
  }

  function initials(name) {
    const parts = String(name || '')
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2);

    if (!parts.length) return 'U';
    return parts.map((part) => part.charAt(0).toUpperCase()).join('');
  }

  function renderUserIdentity() {
    const chip = document.querySelector('.user-chip');
    if (!chip) return;

    const nameElement = chip.querySelector('strong');
    const detailElement = chip.querySelector('small');
    const avatarElement = chip.querySelector('.avatar');

    const name = String(currentUser?.name || nameElement?.textContent || 'Usuário').trim() || 'Usuário';

    if (nameElement) nameElement.textContent = name;
    if (detailElement) detailElement.textContent = roleLabel(currentUser?.role);
    if (avatarElement) avatarElement.textContent = initials(name);

    chip.setAttribute('aria-label', `${name}, ${roleLabel(currentUser?.role)}`);
  }

  async function loadCurrentUser() {
    const now = Date.now();
    if (requestInFlight) return requestInFlight;
    if ((now - lastRequestAt) < 800) {
      renderUserIdentity();
      return currentUser;
    }

    lastRequestAt = now;
    requestInFlight = fetch('/api/auth/me', {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    })
      .then(async (response) => {
        if (!response.ok) return null;
        const payload = await response.json();
        currentUser = payload?.user || null;
        return currentUser;
      })
      .catch(() => null)
      .finally(() => {
        requestInFlight = null;
        renderUserIdentity();
      });

    return requestInFlight;
  }

  const observer = new MutationObserver(() => {
    if (!document.querySelector('.user-chip')) return;
    renderUserIdentity();
    if (!currentUser) loadCurrentUser();
  });

  observer.observe(app, { childList: true, subtree: true });
  window.addEventListener('hashchange', () => setTimeout(loadCurrentUser, 0));

  loadCurrentUser();
})();
