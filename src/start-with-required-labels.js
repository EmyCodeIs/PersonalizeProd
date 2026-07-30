'use strict';

require('dotenv').config();
require('./core/safeLoggingPreload');

// No Windows, SESSION_ACCESS_AUTO_START decide se o portal local será iniciado.
// Na VPS, `npm run vps:start` cria uma área de trabalho virtual, publica essa
// mesma tela pelo noVNC e inicia o WPPConnect dentro dela.

const INSTAGRAM_WELCOME_URL = 'https://www.instagram.com/personalizeseuambiente?igsh=NW9wYzI5ZHc1MnF2';
const LEGACY_WELCOME_URL = 'https://personalizeseuambiente.com.br/bem-vindos';
const configuredWelcomeUrl = String(process.env.BEM_VINDOS_LINK_URL || '').trim();

// Migra automaticamente o valor antigo. Um link diferente definido futuramente
// no .env continua sendo respeitado.
if (!configuredWelcomeUrl || configuredWelcomeUrl === LEGACY_WELCOME_URL) {
  process.env.BEM_VINDOS_LINK_URL = INSTAGRAM_WELCOME_URL;
}

const duplicateRemovalRequested = ['1', 'true', 'yes', 'sim', 'on']
  .includes(String(process.env.LABEL_MAINTENANCE_AUTO_REMOVE_DUPLICATES || '').trim().toLowerCase());
const duplicateRemovalConfirmed = String(process.env.LABEL_MAINTENANCE_CONFIRM_DELETE || '').trim()
  === 'CONFIRMAR_EXCLUSAO';

if (duplicateRemovalRequested && !duplicateRemovalConfirmed) {
  process.env.LABEL_MAINTENANCE_AUTO_REMOVE_DUPLICATES = 'false';
  console.warn(
    '[LISTAS][SEGURANÇA] remoção automática solicitada, mas não confirmada; '
    + 'as duplicatas serão somente auditadas.',
  );
}

const serviceLabels = require('./core/serviceLabels');
const { ensureRequiredLabelsOnce } = require('./core/requiredLabelsStartup');
const { installIdempotentServiceLabels } = require('./core/idempotentServiceLabels');
const { installLidServiceLabelFix } = require('./core/lidServiceLabelFix');

serviceLabels.initializeServiceLabels = ensureRequiredLabelsOnce;
installIdempotentServiceLabels();
installLidServiceLabelFix();

// Garante que Letreiros, Plotagens, Outros e Suporte sejam sempre tratados
// como o mesmo grupo operacional, mesmo com um .env antigo incompleto.
require('./core/operationalLabelPolicyPreload');

// Mantém somente uma etiqueta operacional. Etiquetas manuais e a etiqueta
// exata do vendedor são preservadas.
require('./core/exclusiveServiceLabelsPreload');
// Impede reaplicações da mesma etiqueta durante o fluxo, finalização e reinícios.
require('./core/serviceLabelAssignmentPreload');

// Instala o catálogo nativo. O catálogo aguarda estabilização; o texto seguinte
// precisa ser confirmado pelo canal antes de a lista de acrílico ser liberada.
require('./core/catalogMostruarioPreload');
require('./core/handoffPreload');
// Precisa carregar antes da proteção administrativa: comandos digitados pelo
// próprio WhatsApp Business voltam ao processador sem ativar handoff.
require('./core/resetCommandHandoffPreload');
// Mantém os comandos ativos somente para os números/IDs administrativos
// configurados separadamente da whitelist geral de atendimento.
require('./core/testCommandAccessPreload');
require('./core/resetCleanupPreload');
// Substitui a limpeza ampla antiga por uma limpeza que remove somente as
// etiquetas gerenciadas, preservando as etiquetas manuais do contato.
require('./core/safeResetCleanupOverridePreload');
require('./core/customerFlowFixPreload');
require('./core/preferredSellerNotePreload');
require('./core/completedFlowSilencePreload');
require('./core/runtimeReliabilityPreload');
// Reexecuta a recuperação segura quando o WhatsApp volta de uma desconexão.
require('./core/unreadReconnectRecoveryPreload');
require('./core/supportAndServicesPreload');
// Aplica Suporte no momento da escolha, não apenas ao finalizar a coleta.
require('./core/supportLabelSelectionPreload');
require('./core/exactAcknowledgementPreload');
require('./core/bufferStagePolicyPreload');

// Primeiro instala as proteções gerais da VPS e, em seguida, amplia a leitura
// exata do vendedor para os aliases @lid e @c.us do mesmo contato.
require('./core/vpsReadinessPreload');
require('./core/sellerAliasHandoffPreload');
// Escuta a inclusão/remoção de etiqueta de vendedor mesmo após o fluxo concluído.
require('./core/sellerLabelEventsPreload');

// As limpezas acontecem antes de o Chrome abrir. Durante a execução há apenas monitoramento.
const TokenCache = require('./core/tokenCacheMaintenance');
const BrowserCache = require('./core/browserCacheMaintenance');
const Persistence = require('./services/persistence');
const { startQrAdminServer } = require('./services/qrAdminServer');

TokenCache.runStartupTokenCacheMaintenance();
TokenCache.startTokenCacheMonitor();
BrowserCache.runStartupBrowserCacheMaintenance();
BrowserCache.startBrowserCacheMonitor();
startQrAdminServer();

const storage = Persistence.storageInfo();
if (storage.driver === 'sqlite') Persistence.getDatabase();
console.log(`[BANCO] driver=${storage.driver} | criptografado=${storage.encrypted ? 'sim' : 'não'}`);
console.log('[BUILD] personalize-vps-secure-sqlite-v1');
require('./bootstrap');
