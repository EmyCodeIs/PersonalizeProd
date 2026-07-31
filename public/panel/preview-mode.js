'use strict';

(() => {
  const query = new URLSearchParams(window.location.search);
  window.__PERSONALIZE_FRONTEND_PREVIEW__ = query.get('preview') === '1' || window.location.port === '4173';
  if (window.__PERSONALIZE_FRONTEND_PREVIEW__) {
    document.documentElement.dataset.frontendPreview = 'true';
  }
})();
