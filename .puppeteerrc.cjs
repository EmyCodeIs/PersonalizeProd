'use strict';

// O projeto usa o Chrome instalado no sistema. Evita downloads duplicados e
// caches incompletos do Chrome for Testing durante npm ci/npm install.
module.exports = {
  skipDownload: true,
  chrome: { skipDownload: true },
  'chrome-headless-shell': { skipDownload: true },
  firefox: { skipDownload: true },
};
