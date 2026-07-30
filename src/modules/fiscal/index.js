'use strict';

const fs = require('node:fs');
const { createConfig } = require('./config');
const { createDatabase } = require('./db');
const { FocusClient } = require('./focusClient');
const { createServer } = require('./server');

let config;
try {
  config = createConfig();
} catch (error) {
  console.error(`\nPERSONALIZE NF NÃO INICIOU\n${error.message}\n`);
  process.exit(1);
}

fs.mkdirSync(config.documentDirectory, { recursive: true });
const db = createDatabase(config);
const focus = new FocusClient(config);
const server = createServer({ config, db, focus });

server.listen(config.port, config.host, () => {
  console.log(`\nPersonalize NF disponível em http://${config.host}:${config.port}`);
  console.log(`Modo operacional: ${config.runtimeMode}`);
  console.log(`Ambiente Focus: ${config.focus.environment}`);
  console.log(`Modo demonstração: ${config.demoMode ? 'ATIVO — nenhuma nota real será emitida' : 'DESATIVADO'}`);
  console.log(`Token do ambiente: ${config.demoMode ? 'NÃO UTILIZADO NA DEMONSTRAÇÃO' : 'CONFIGURADO'}`);
  console.log(`Série DPS ativa: ${config.dpsSeries}`);
  console.log(`Webhook: ${config.focus.webhookSecret ? 'CONFIGURADO' : 'OPCIONAL / DESATIVADO'}`);
  if (!config.demoMode && config.focus.environment === 'producao') {
    console.log('ATENÇÃO: EMISSÕES COM VALIDADE FISCAL ESTÃO ATIVAS.');
  }
  console.log(`Login: ${config.admin.email}\n`);
});

function shutdown(signal) {
  console.log(`Encerrando (${signal})...`);
  server.close(() => {
    try { db.close(); } catch {}
    process.exit(0);
  });
}
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
