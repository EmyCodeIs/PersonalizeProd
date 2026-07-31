'use strict';

(() => {
  if (!window.__PERSONALIZE_FRONTEND_PREVIEW__ || !window.MutationObserver) return;
  const NativeMutationObserver = window.MutationObserver;

  window.MutationObserver = class PreviewMutationObserver extends NativeMutationObserver {
    constructor(callback) {
      super((records, observer) => {
        const onlyPreviewWrites = records.length > 0 && records.every((record) => {
          const target = record.target?.nodeType === 1 ? record.target : record.target?.parentElement;
          if (!target?.closest) return false;
          return Boolean(target.closest('.content[data-preview-route], .sidebar-nav, .mobile-nav'));
        });
        if (!onlyPreviewWrites) callback(records, observer);
      });
    }
  };

  window.setTimeout(() => {
    window.MutationObserver = NativeMutationObserver;
  }, 0);
})();
