'use strict';

(() => {
  if (!window.__PERSONALIZE_FRONTEND_PREVIEW__ || !window.MutationObserver) return;

  const NativeMutationObserver = window.MutationObserver;

  class PreviewNoopMutationObserver {
    constructor() {
      this.observing = false;
    }

    observe() {
      this.observing = true;
    }

    disconnect() {
      this.observing = false;
    }

    takeRecords() {
      return [];
    }
  }

  // O workspace da prévia já renderiza no carregamento e em cada hashchange.
  // Desativar somente o observer criado por ele evita o ciclo:
  // render -> mutation -> render -> mutation.
  window.MutationObserver = PreviewNoopMutationObserver;

  window.setTimeout(() => {
    window.MutationObserver = NativeMutationObserver;
  }, 0);
})();
