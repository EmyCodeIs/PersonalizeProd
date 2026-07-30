'use strict';

require('dotenv').config();

function bool(name, fallback = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === '') return fallback;
  return ['1', 'true', 'yes', 'sim', 'on'].includes(String(raw).trim().toLowerCase());
}

function num(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function list(name, fallback = []) {
  const raw = process.env[name];
  if (raw === undefined || raw === null) return fallback;
  if (String(raw).trim() === '') return [];
  return String(raw)
    .split(/[;,\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function mapList(name) {
  const raw = process.env[name];
  if (!raw) return {};
  return String(raw)
    .split(/[;,\n]/)
    .map((item) => item.trim())
    .filter(Boolean)
    .reduce((acc, item) => {
      const [key, value] = item.split('=').map((part) => String(part || '').trim());
      if (key && value) acc[key.toLowerCase()] = value;
      return acc;
    }, {});
}

// Cores verificadas nas etiquetas já existentes do WhatsApp Business.
// O sistema reutiliza essas etiquetas pelo nome e não troca a cor de uma
// etiqueta existente. Os hexadecimais servem para conferência e criação apenas
// quando uma etiqueta obrigatória realmente não existir.
const DEFAULT_SELLER_LABEL_RULES = Object.freeze({
  adriano: '#8fd0a8',
  ana: '#00a4f2',
  emy: '#7fe51f',
  'c. eduardo': '#feb100',
});

const LEGACY_SELLER_LABEL_ALIASES = Object.freeze({
  aninha: 'ana',
  carlos: 'c. eduardo',
});

function sellerLabelRules() {
  const configured = mapList('SELLER_LABEL_RULES');
  const resolved = { ...DEFAULT_SELLER_LABEL_RULES };

  for (const [rawName, rawColor] of Object.entries(configured)) {
    const name = LEGACY_SELLER_LABEL_ALIASES[rawName] || rawName;
    const color = String(rawColor || '').trim();
    if (!name || !color) continue;

    // Configurações antigas usavam nomes genéricos e cores aproximadas.
    // Para os vendedores já verificados, somente um hexadecimal explícito
    // substitui a cor real; assim um .env antigo não cria Aninha/Carlos.
    if (Object.prototype.hasOwnProperty.call(DEFAULT_SELLER_LABEL_RULES, name)
      && !/^#[0-9a-f]{6}$/i.test(color)) {
      continue;
    }

    resolved[name] = color;
  }

  return resolved;
}

const INSTAGRAM_WELCOME_URL = 'https://www.instagram.com/personalizeseuambiente?igsh=NW9wYzI5ZHc1MnF2';
const DEFAULT_CATALOG_NAME = 'Mostruário Letreiros';
const serviceLabelLetreiro = process.env.SERVICE_LABEL_LETREIRO || 'Orçamento letreiros';
const serviceLabelPlotagem = process.env.SERVICE_LABEL_PLOTAGEM || 'Plotagens';
const serviceLabelOutros = process.env.SERVICE_LABEL_OUTROS || 'Outros';
const supportLabelName = process.env.SERVICE_LABEL_SUPPORT || 'Suporte';
const serviceLabelLetreiroColor = process.env.SERVICE_LABEL_LETREIRO_COLOR || 'purple';
const supportLabelColor = process.env.SERVICE_LABEL_SUPPORT_COLOR || 'red';
const flowSessionTtlHours = Math.max(1, num('FLOW_SESSION_TTL_HOURS', 24));

const env = {
  sessionName: process.env.WPP_SESSION_NAME || 'personalize-wppconnect',
  mockMode: bool('MOCK_MODE', false),
  wppHeadless: bool('WPP_HEADLESS', false),
  enableTestCommands: bool('ENABLE_TEST_COMMANDS', false),
  businessName: process.env.BUSINESS_NAME || 'Personalize',
  sellerName: process.env.SELLER_NAME || 'Vendedor Personalize',

  // Memória curta do fluxo. Após o TTL, a conversa volta ao início.
  flowSessionTtlHours,
  completedSessionTtlHours: Math.max(1, num('COMPLETED_SESSION_TTL_HOURS', flowSessionTtlHours)),

  // Limpeza periódica e limites dos caches mantidos em memória na VPS.
  maintenanceIntervalMs: Math.max(60000, num('MAINTENANCE_INTERVAL_MS', 900000)),
  runtimeCacheMaxEntries: Math.max(500, num('RUNTIME_CACHE_MAX_ENTRIES', 5000)),
  botActivityTtlDays: Math.max(1, num('BOT_ACTIVITY_TTL_DAYS', 30)),
  runtimeProtectionEnabled: bool('RUNTIME_PROTECTION_ENABLED', true),
  runtimeProtectionCheckMs: Math.max(5000, num('RUNTIME_PROTECTION_CHECK_MS', 15000)),
  runtimePressureCooldownMs: Math.max(10000, num('RUNTIME_PRESSURE_COOLDOWN_MS', 60000)),
  runtimePressureQueueThreshold: Math.max(1, num('RUNTIME_PRESSURE_QUEUE_THRESHOLD', 14)),
  runtimePressureCriticalQueueThreshold: Math.max(1, num('RUNTIME_PRESSURE_CRITICAL_QUEUE_THRESHOLD', 26)),
  runtimePressureRssMb: Math.max(128, num('RUNTIME_PRESSURE_RSS_MB', 350)),
  runtimePressureCriticalRssMb: Math.max(256, num('RUNTIME_PRESSURE_CRITICAL_RSS_MB', 550)),
  tokenCacheRoot: process.env.TOKEN_CACHE_ROOT || 'tokens',
  tokenCacheMaxAgeDays: Math.max(0, num('TOKEN_CACHE_MAX_AGE_DAYS', 7)),
  tokenCacheAutoClean: bool('TOKEN_CACHE_AUTO_CLEAN', true),
  tokenCacheForceCleanMb: Math.max(50, num('TOKEN_CACHE_FORCE_CLEAN_MB', 300)),
  tokenCacheWarnMb: Math.max(100, num('TOKEN_CACHE_WARN_MB', 500)),
  tokenCacheLogIntervalHours: Math.max(1, num('TOKEN_CACHE_LOG_INTERVAL_HOURS', 6)),

  // Controle global de concorrência/consumo para evitar excesso de processamento simultâneo.
  queueMaxUnits: Math.max(1, num('QUEUE_MAX_UNITS', num('MAX_CONCURRENT_CHATS', 2))),
  maxConcurrentChats: Math.max(1, num('MAX_CONCURRENT_CHATS', 2)),
  maxQueueSize: Math.max(1, num('MAX_QUEUE_SIZE', 40)),
  chatProcessTimeoutMs: Math.max(5000, num('CHAT_PROCESS_TIMEOUT_MS', 45000)),

  // Handoff humano / vendedores.
  sellerLabelBlockingEnabled: bool('SELLER_LABEL_BLOCKING_ENABLED', true),
  sellerLabelRules: sellerLabelRules(),
  humanBlockHours: Math.max(1, num('HUMAN_BLOCK_HOURS', 24)),
  labelMaintenanceAutoRemoveDuplicates: bool('LABEL_MAINTENANCE_AUTO_REMOVE_DUPLICATES', false),

  // A primeira entrada aguarda pelo menos 8s para agrupar saudação, nome e pedido.
  // As demais respostas simples continuam usando BUFFER_MS.
  firstInputBufferMs: Math.max(8000, num('FIRST_INPUT_BUFFER_MS', 8000)),
  // Entrada do cliente. O buffer curto atende respostas simples; o longo é usado
  // em medidas, arte, endereço, Pantone, suporte e observações com várias mensagens.
  bufferMs: Math.max(800, num('BUFFER_MS', 4500)),
  multiMessageBufferMs: Math.max(2500, num('MULTI_MESSAGE_BUFFER_MS', 8000)),
  measureBufferMs: Math.max(2500, num('MEASURE_BUFFER_MS', 8000)),
  // Arte precisa de mais tempo porque imagem, legenda e referência podem chegar separadas.
  // O mínimo de 14s prevalece mesmo quando um .env antigo ainda possui valores menores.
  artBufferMs: Math.max(14000, num('ART_BUFFER_MS', 14000)),
  addressBufferMs: Math.max(2500, num('ADDRESS_BUFFER_MS', 8000)),
  pantoneBufferMs: Math.max(2500, num('PANTONE_BUFFER_MS', 8000)),
  observationBufferMs: Math.max(2500, num('OBSERVATION_BUFFER_MS', 9000)),
  supportBufferMs: Math.max(5000, num('SUPPORT_BUFFER_MS', 9000)),
  cityBufferMs: Math.max(800, num('CITY_BUFFER_MS', 2500)),
  interactiveBufferMs: Math.max(100, num('INTERACTIVE_BUFFER_MS', 350)),

  // Mantidos para respostas avulsas. Dentro de um grupo de resposta o sistema
  // ignora esses delays e envia os balões em sequência, sem pausas artificiais.
  minReplyDelayMs: Math.max(0, num('MIN_REPLY_DELAY_MS', 1800)),
  maxReplyDelayMs: Math.max(0, num('MAX_REPLY_DELAY_MS', 4200)),
  enableTyping: bool('ENABLE_TYPING', true),
  typingMinMs: Math.max(0, num('TYPING_MIN_MS', 650)),
  typingMaxMs: Math.max(0, num('TYPING_MAX_MS', 1600)),
  typingCharsPerSecond: Math.max(10, num('TYPING_CHARS_PER_SECOND', 45)),

  stopNonLetteringFlow: bool('STOP_NON_LETTERING_FLOW', true),
  enableContactNotes: bool('ENABLE_CONTACT_NOTES', true),
  enableContactLabels: bool('ENABLE_CONTACT_LABELS', true),
  detectManualContactLabels: bool('DETECT_MANUAL_CONTACT_LABELS', true),
  storeManualContactLabels: bool('STORE_MANUAL_CONTACT_LABELS', true),
  awaitingQuoteLabelName: process.env.AWAITING_QUOTE_LABEL_NAME || serviceLabelLetreiro,
  awaitingQuoteLabelColor: process.env.AWAITING_QUOTE_LABEL_COLOR || serviceLabelLetreiroColor,
  serviceLabelLetreiro,
  serviceLabelPlotagem,
  serviceLabelOutros,
  supportLabelName,
  serviceLabelLetreiroColor,
  serviceLabelPlotagemColor: process.env.SERVICE_LABEL_PLOTAGEM_COLOR || 'gray',
  serviceLabelOutrosColor: process.env.SERVICE_LABEL_OUTROS_COLOR || 'red',
  supportLabelColor,
  serviceLabelReplaceGroup: list(
    'SERVICE_LABEL_REPLACE_GROUP',
    [serviceLabelLetreiro, serviceLabelPlotagem, serviceLabelOutros, supportLabelName],
  ),
  enableUnreadBootstrap: bool('ENABLE_UNREAD_BOOTSTRAP', false),
  unreadBootstrapDelayMs: Math.max(1000, num('UNREAD_BOOTSTRAP_DELAY_MS', 6000)),
  unreadBootstrapAttempts: Math.max(1, num('UNREAD_BOOTSTRAP_ATTEMPTS', 3)),
  unreadBootstrapRetryDelayMs: Math.max(500, num('UNREAD_BOOTSTRAP_RETRY_DELAY_MS', 2500)),
  unreadBootstrapMaxChats: Math.max(1, num('UNREAD_BOOTSTRAP_MAX_CHATS', 30)),
  unreadBootstrapMaxMessagesPerChat: Math.max(1, num('UNREAD_BOOTSTRAP_MAX_MESSAGES_PER_CHAT', 8)),
  unreadRecoveryHistoryLimit: Math.max(20, num('UNREAD_RECOVERY_HISTORY_LIMIT', 120)),
  unreadBootstrapMaxAgeHours: Math.max(1, num('UNREAD_BOOTSTRAP_MAX_AGE_HOURS', 24)),
  allowedClientNumbers: list('ALLOWED_CLIENT_NUMBERS', []),
  allowedChatIds: list('ALLOWED_CHAT_IDS', []),
  lidNumberMap: mapList('LID_NUMBER_MAP'),
  assetsDir: process.env.ASSETS_DIR || 'assets',
  bemVindosImageBaseName: process.env.BEM_VINDOS_IMAGE_BASENAME || 'capa_bem_vindos',
  bemVindosLinkUrl: process.env.BEM_VINDOS_LINK_URL || INSTAGRAM_WELCOME_URL,
  mostruarioCatalogName: process.env.MOSTRUARIO_CATALOG_NAME || DEFAULT_CATALOG_NAME,
  mostruarioLinkUrl:
    process.env.MOSTRUARIO_LINK_URL
    || process.env.MOSTRUARIO_LETREIRO_LINK_URL
    || 'https://personalizeseuambiente.com.br/mostruario-letreiros',
  assetTabelaCoresBaseName: process.env.ASSET_TABELA_CORES_BASE_NAME || 'tabela-cores-v2',
  assetTabelaEspessuraBaseName: process.env.ASSET_TABELA_ESPESSURA_BASE_NAME || 'tabela-espessura',
  assetTabelaProfundidadeBaseName: process.env.ASSET_TABELA_PROFUNDIDADE_BASE_NAME || 'tabela-profundidade-3mm',
};

if (env.maxReplyDelayMs < env.minReplyDelayMs) env.maxReplyDelayMs = env.minReplyDelayMs;
if (env.typingMaxMs < env.typingMinMs) env.typingMaxMs = env.typingMinMs;

module.exports = {
  DEFAULT_CATALOG_NAME,
  DEFAULT_SELLER_LABEL_RULES,
  INSTAGRAM_WELCOME_URL,
  env,
};