'use strict';

process.env.PERSONALIZE_ENV_OVERRIDE = 'true';

const { createConfig } = require('../src/modules/fiscal/config');
const { FocusClient } = require('../src/modules/fiscal/focusClient');

async function main() {
  const config = createConfig();

  if (config.demoMode) {
    throw new Error('DEMO_MODE está true. Altere para false antes do teste real de homologação.');
  }
  if (config.focus.environment !== 'homologacao') {
    throw new Error('FOCUS_ENVIRONMENT precisa estar como homologacao para este teste.');
  }
  if (!config.focus.token) {
    throw new Error('FOCUS_TOKEN_HOMOLOGACAO não está configurado.');
  }

  const focus = new FocusClient(config);
  const reference = `PNF_SMOKE_${Date.now()}`;
  const startedAt = Date.now();

  try {
    await focus.consult(reference);
    console.log('✅ Endpoint NFS-e Nacional respondeu em homologação.');
  } catch (error) {
    if (error.code === 'FOCUS_HTTP_404') {
      console.log('✅ Focus homologação autenticada: consulta chegou ao endpoint NFS-e Nacional.');
      console.log('   A referência inexistente retornou 404, como esperado para um teste sem emissão.');
    } else {
      throw error;
    }
  }

  const company = await focus.lookupCnpj(config.company.cnpj);
  const companyName = company?.razao_social || company?.nome || company?.nome_fantasia || 'CNPJ consultado';
  console.log(`✅ Token aceito e consulta de CNPJ concluída: ${companyName}.`);
  console.log(`✅ Ambiente: homologação | tempo: ${Date.now() - startedAt}ms | nenhuma nota foi emitida.`);
}

main().catch((error) => {
  const detail = error?.response ? `\nDetalhes: ${JSON.stringify(error.response)}` : '';
  console.error(`❌ Teste real da Focus falhou: ${error.message}${detail}`);
  process.exitCode = 1;
});
