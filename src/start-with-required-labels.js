'use strict';

require('dotenv').config();
require('./core/safeLoggingPreload');
// Precisa carregar antes de qualquer módulo que importe wppconnectClient:
// aplica timeout finito, observa o client real e corrige a semântica READY.
require('./core/connectionSupervisorPreload');

// No Windows, SESSION_ACCESS_AUTO_START decide se o portal local será iniciado.
// Na VPS, `npm run vps:start` cria uma área de trabalho virtual, publica essa
// mesma tela pelo noVNC e inicia o WPPConnect dentro dela.

const INSTAGRAM_WELCOME_URL = 'https://www.instagram.com/personalizeseuambiente?igsh=NW9wYzI5ZHc1MnF2';
const LEGACY_WELCOME_URL = 'https://personalizeseuambiente.com.br/bem-vindos';
const configuredWelcomeUrl = String(process.env.BEM_VINDOS_LINK_URL || '').trim();

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

require('./core/operationalLabelPolicyPreload');
require('./core/exclusiveServiceLabelsPreload');
require('./core/serviceLabelAssignmentPreload');

require('./core/catalogMostruarioPreload');
// Mantém apenas o monitor de mensagens manuais e operações internas de etiqueta.
// A decisão de handoff fica concentrada em sellerHandoff + labelPolicy.
require('./core/handoffPreload');
require('./core/resetCommandHandoffPreload');
require('./core/testCommandAccessPreload');
// /resetarsys é executado diretamente por um único serviço, depois da autorização
// administrativa e antes de chegar ao fluxo legado.
require('./core/resetServicePreload');
require('./core/customerFlowFixPreload');
require('./core/preferredSellerNotePreload');
require('./core/completedFlowSilencePreload');
require('./core/runtimeReliabilityPreload');
require('./core/unreadReconnectRecoveryPreload');
require('./core/supportAndServicesPreload');
require('./core/supportLabelSelectionPreload');
require('./core/exactAcknowledgementPreload');
require('./core/bufferStagePolicyPreload');

// A prontidão da VPS não substitui mais as decisões de handoff.
require('./core/vpsReadinessPreload');
require('./core/sellerLabelEventsPreload');

// Precisa ser o último preload funcional da Inbox: captura a versão final do fluxo,
// do buffer e do canal para persistir recebimento, leases, retries e deduplicação.
require('./core/messageInboxPreload');
// Camada externa final: mensagens ficam persistidas, mas não entram no fluxo até READY.
require('./core/connectionReadinessGatePreload');

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
console.log('[BUILD] personalize-vps-connection-supervisor-v3');
require('./bootstrap');
