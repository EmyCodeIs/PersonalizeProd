'use strict';

require('dotenv').config();
require('./core/safeLoggingPreload');

// No Windows, SESSION_ACCESS_AUTO_START decide se o portal local será iniciado.
// Na VPS, `npm run vps:start` cria uma área de trabalho virtual, publica essa
// mesma tela pelo noVNC e inicia o WPPConnect dentro dela.

const INSTAGRAM_WELCOME_URL = 'https://www.instagram.com/personalizeseuambiente?igsh=NW9wYzI5ZHc1MnF2';
const LEGACY_WELCOME_URL = 'https://personalizeseuambiente.com.br/bem-vindos';
const configuredWelcomeUrl = String(process.env.BEM_VINDOS_LINK_URL || '').trim();

if (!configuredWelcomeUrl || configuredWelcomeUrl === LEGACY_WELCOME_URL) {
  process.env.BEM_VINDOS_LINK_URL = INSTAGRAM_WELCOME_URL;
}

const confirmedLabelDeletion = String(process.env.LABEL_MAINTENANCE_CONFIRM_DELETE || '').trim()
  === 'CONFIRMAR_EXCLUSAO';
const automaticLabelCleanupFlags = [
  ['LABEL_MAINTENANCE_AUTO_REMOVE_DUPLICATES', 'as duplicatas'],
  ['LABEL_MAINTENANCE_AUTO_REMOVE_CORRUPT_SYMBOLS', 'as etiquetas corrompidas por símbolos'],
];

for (const [flag, description] of automaticLabelCleanupFlags) {
  const requested = ['1', 'true', 'yes', 'sim', 'on']
    .includes(String(process.env[flag] || '').trim().toLowerCase());
  if (requested && !confirmedLabelDeletion) {
    process.env[flag] = 'false';
    console.warn(
      `[LISTAS][SEGURANÇA] remoção automática solicitada, mas não confirmada; ${description} serão somente auditadas.`,
    );
  }
}

require('./core/synchronizationGuardPreload');

const serviceLabels = require('./core/serviceLabels');
const { ensureRequiredLabelsOnce } = require('./core/requiredLabelsStartup');
const { installIdempotentServiceLabels } = require('./core/idempotentServiceLabels');
const { installLidServiceLabelFix } = require('./core/lidServiceLabelFix');

serviceLabels.initializeServiceLabels = ensureRequiredLabelsOnce;
installIdempotentServiceLabels();
installLidServiceLabelFix();

require('./core/operationalLabelPolicyPreload');
require('./core/exclusiveServiceLabelsPreload');
require('./core/serviceLabelAssignmentPreload');
require('./core/corruptLabelMaintenance');
require('./core/catalogMostruarioPreload');
require('./core/handoffPreload');
require('./core/resetCommandHandoffPreload');
require('./core/testCommandAccessPreload');
require('./core/handoffHistoryPolicyPreload');
require('./core/resetCleanupPreload');
require('./core/safeResetCleanupOverridePreload');
require('./core/customerFlowFixPreload');
require('./core/preferredSellerNotePreload');
require('./core/completedFlowSilencePreload');
require('./core/runtimeReliabilityPreload');
require('./core/unreadReconnectRecoveryPreload');
require('./core/supportAndServicesPreload');
require('./core/supportLabelSelectionPreload');
require('./core/exactAcknowledgementPreload');
require('./core/bufferStagePolicyPreload');
require('./core/vpsReadinessPreload');
require('./core/sellerAliasHandoffPreload');
require('./core/handoffSafetyPreload');
require('./core/testerHandoffBypassPreload');
require('./core/sellerLabelEventsPreload');
require('./core/runtimeOptimizationPreload');
require('./core/gracefulHealthPreload');
require('./core/handoffSleepPreload');

const TokenCache = require('./core/tokenCacheMaintenance');
const BrowserCache = require('./core/browserCacheMaintenance');
const Persistence = require('./services/persistence');
const { startQrAdminServer } = require('./services/qrAdminServer');
const { startFiscalModuleProcess } = require('./modules/fiscal/process');
const { startUnifiedPanelServer } = require('./modules/panel/server');

TokenCache.runStartupTokenCacheMaintenance();
TokenCache.startTokenCacheMonitor();
BrowserCache.runStartupBrowserCacheMaintenance();
BrowserCache.startBrowserCacheMonitor();
startQrAdminServer();

// O fiscal roda em processo filho: falhas da Focus ou do banco fiscal não derrubam o bot.
try {
  startFiscalModuleProcess();
} catch (error) {
  console.warn('[FISCAL] falha isolada ao iniciar:', error?.message || error);
}

// O painel apenas lê APIs locais e faz proxy autenticado para o fiscal.
try {
  startUnifiedPanelServer();
} catch (error) {
  console.warn('[PAINEL] falha isolada ao iniciar:', error?.message || error);
}

const storage = Persistence.storageInfo();
if (storage.driver === 'sqlite') Persistence.getDatabase();
console.log(`[BANCO] driver=${storage.driver} | criptografado=${storage.encrypted ? 'sim' : 'não'}`);
console.log('[BUILD] personalize-bot-painel-fiscal-unificado-v1');
require('./bootstrap');
