'use strict';

require('dotenv').config();
const { cleanupStaleProfileMarkers } = require('../src/core/browserProfileRecovery');

const result = cleanupStaleProfileMarkers();
if (result.active) {
  console.log(`[PERFIL-CHROME] perfil em uso; marcadores preservados | caminho=${result.profilePath}`);
  process.exit(0);
}
console.log(
  `[PERFIL-CHROME] limpeza pré-start | encontrados=${result.found} | removidos=${result.removed} `
  + `| falhas=${result.failures} | autenticação=preservada`,
);
if (result.failures > 0) process.exitCode = 1;
