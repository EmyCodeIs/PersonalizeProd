'use strict';

(() => {
  const embedded = window.self !== window.top
    || new URLSearchParams(window.location.search).get('embedded') === '1'
    || window.location.pathname === '/fiscal'
    || window.location.pathname.startsWith('/fiscal/');

  // Dentro do painel unificado, as rotas /fiscal/* precisam chegar ao proxy.
  if (embedded) return;

  const stripFiscalPrefix = (value) => {
    if (typeof value !== 'string') return value;
    if (value.startsWith('/fiscal/')) return value.slice('/fiscal'.length);
    if (value === '/fiscal') return '/';
    return value;
  };

  const nativeFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    if (typeof input === 'string') return nativeFetch(stripFiscalPrefix(input), init);
    if (input instanceof Request) {
      const url = new URL(input.url, window.location.href);
      url.pathname = stripFiscalPrefix(url.pathname);
      return nativeFetch(new Request(url, input), init);
    }
    return nativeFetch(input, init);
  };

  document.addEventListener('click', (event) => {
    const link = event.target.closest?.('a[href^="/fiscal/"]');
    if (!link) return;
    link.href = stripFiscalPrefix(link.getAttribute('href'));
  }, true);
})();
