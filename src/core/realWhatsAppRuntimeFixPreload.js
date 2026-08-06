'use strict';

const { env } = require('../config/env');
const Identity = require('../services/contactIdentity');
const Conn = require('../services/connectionSupervisor');

const {
  ConnectionSupervisor,
  DISCONNECTED_RAW_STATES,
  QR_RAW_STATES,
  READY_RAW_STATES,
  STATES,
  normalizeRawState,
  withTimeout,
} = Conn;

const READY_HINTS = new Set(['CONNECTED', 'INCHAT']);
const EARLY_MOBILE = new Set(['DISCONNECTEDMOBILE', 'PHONE_NOT_CONNECTED', 'PHONENOTCONNECTED']);

function clearProbe(supervisor) {
  if (supervisor.__realProbeTimer) clearTimeout(supervisor.__realProbeTimer);
  supervisor.__realProbeTimer = null;
}

function scheduleProbe(supervisor, source = 'readiness_retry', delay = 1000) {
  if (supervisor.disposed || supervisor.isReady() || supervisor.state === STATES.WAITING_QR) return;
  if (supervisor.__realProbeTimer) return;
  const generation = supervisor.generation;
  supervisor.__realProbeTimer = setTimeout(() => {
    supervisor.__realProbeTimer = null;
    if (supervisor.disposed || generation !== supervisor.generation || supervisor.isReady()) return;
    void supervisor.probe(source).catch((error) => {
      supervisor.logger.warn('[CONEXÃO] retry de prontidão falhou:', error?.message || error);
    });
  }, delay);
  supervisor.__realProbeTimer.unref?.();
}

function patchConnection() {
  if (ConnectionSupervisor.prototype.__realWhatsappPatched) return;

  // O preload de conexão usa este mesmo Set. Vazio, nenhum texto cru como
  // INCHAT pode publicar conectado antes da prova estrita.
  READY_RAW_STATES.clear();

  const originalObserve = ConnectionSupervisor.prototype.observeState;
  const originalReady = ConnectionSupervisor.prototype.markReady;
  const originalWaitingQr = ConnectionSupervisor.prototype.enterWaitingQr;
  const originalClear = ConnectionSupervisor.prototype.clearTimers;
  const originalDispose = ConnectionSupervisor.prototype.dispose;

  ConnectionSupervisor.prototype.clearTimers = function clearTimers() {
    clearProbe(this);
    return originalClear.call(this);
  };

  ConnectionSupervisor.prototype.dispose = function dispose() {
    clearProbe(this);
    return originalDispose.call(this);
  };

  ConnectionSupervisor.prototype.enterWaitingQr = function enterWaitingQr(details = {}) {
    clearProbe(this);
    return originalWaitingQr.call(this, details);
  };

  ConnectionSupervisor.prototype.markReady = function markReady(details = {}) {
    clearProbe(this);
    const result = originalReady.call(this, details);
    const raw = normalizeRawState(details.rawState) || 'CONNECTED';

    // Libera a publicação no painel apenas depois da prova estrita.
    READY_RAW_STATES.add(raw);
    try {
      require('../services/qrAccess').publishConnected(raw);
    } catch (error) {
      this.logger.warn('[CONEXÃO] falha ao publicar READY:', error?.message || error);
    } finally {
      READY_RAW_STATES.delete(raw);
    }
    return result;
  };

  ConnectionSupervisor.prototype.observeState = function observeState(
    value,
    { source = 'runtime', generation = this.generation } = {},
  ) {
    if (this.disposed || generation !== this.generation) return { ignored: true, reason: 'STALE_GENERATION' };
    const raw = normalizeRawState(value);
    if (!raw) return { ignored: true, reason: 'EMPTY_STATE' };

    if (READY_HINTS.has(raw)) {
      this.rawState = raw;
      this.rawSource = source;
      if (!this.isReady()) {
        this.transition(STATES.AUTHENTICATING, { reason: `${source}:${raw}:strict_probe` });
      }
      void this.probe(`state_${source}`).catch((error) => {
        this.logger.warn('[CONEXÃO] prova estrita falhou:', error?.message || error);
      });
      return { ignored: false, state: this.state };
    }

    if (EARLY_MOBILE.has(raw) && !this.lastReadyAt) {
      this.rawState = raw;
      this.rawSource = source;
      this.transition(STATES.AUTHENTICATING, { reason: `${source}:${raw}:awaiting_pairing` });
      scheduleProbe(this, 'early_mobile_disconnect', 700);
      return { ignored: false, state: this.state };
    }

    return originalObserve.call(this, value, { source, generation });
  };

  ConnectionSupervisor.prototype.probe = async function probe(source = 'runtime') {
    if (this.disposed || !this.client) return { available: false, ready: false };
    const generation = this.generation;
    const result = {
      available: true,
      ready: false,
      source,
      connectionState: null,
      page: null,
      at: new Date().toISOString(),
    };

    try {
      const state = await this.callClientMethod('getConnectionState');
      if (state.available) result.connectionState = normalizeRawState(state.value);
    } catch (error) {
      result.connectionStateError = String(error?.message || error);
    }

    const page = this.client?.page || this.client?.waPage;
    if (typeof page?.evaluate === 'function') {
      try {
        result.page = await withTimeout(page.evaluate(async () => {
          const WPP = window.WPP || null;
          const read = async (owner, value) => {
            try {
              return typeof value === 'function' ? await value.call(owner) : value ?? null;
            } catch (_) {
              return null;
            }
          };
          return {
            authenticated: await read(WPP?.conn, WPP?.conn?.isAuthenticated),
            mainReady: await read(WPP?.conn, WPP?.conn?.isMainReady),
            fullReady: await read(WPP, WPP?.isFullReady),
            streamMode: await read(WPP?.conn, WPP?.conn?.getStreamMode),
            streamInfo: await read(WPP?.conn, WPP?.conn?.getStreamInfo),
          };
        }), this.config.probeTimeoutMs, 'CONNECTION_PAGE_READINESS_TIMEOUT');
      } catch (error) {
        result.pageError = String(error?.message || error);
      }
    }

    if (this.disposed || generation !== this.generation) return { ...result, stale: true };
    this.lastProbeAt = result.at;
    this.lastProbe = result;

    const authenticated = result.page?.authenticated === true;
    const unauthenticated = result.page?.authenticated === false;
    const mainReady = result.page?.mainReady === true || result.page?.fullReady === true;
    const mode = normalizeRawState(result.page?.streamMode);
    const info = normalizeRawState(result.page?.streamInfo);
    const streamReady = (!mode && !info) || mode === 'MAIN' || info === 'NORMAL';

    if (authenticated && mainReady && streamReady) {
      result.ready = true;
      this.markReady({ source: `probe:${source}`, rawState: result.connectionState || 'CONNECTED' });
      return result;
    }

    if (unauthenticated || QR_RAW_STATES.has(result.connectionState)) {
      this.enterWaitingQr({
        source: `probe:${source}`,
        rawState: QR_RAW_STATES.has(result.connectionState) ? result.connectionState : 'UNPAIRED',
      });
      return result;
    }

    if (authenticated) {
      this.enterSyncing({ source: `probe:${source}`, rawState: result.connectionState || 'SYNCING' });
    } else if (result.connectionState && DISCONNECTED_RAW_STATES.has(result.connectionState)) {
      this.observeState(result.connectionState, { source: `probe:${source}`, generation });
    } else {
      this.transition(STATES.AUTHENTICATING, { reason: `probe:${source}:not_confirmed` });
    }

    scheduleProbe(this);
    return result;
  };

  Object.defineProperty(ConnectionSupervisor.prototype, '__realWhatsappPatched', { value: true });
}

const COLORS = {
  green: '#00a884', red: '#ea0038', gray: '#667781', grey: '#667781',
  blue: '#027eb5', yellow: '#f7b928', orange: '#ff7a00',
  purple: '#7f66ff', pink: '#ff7eb6',
};

function norm(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/\s+/g, ' ').trim();
}

function labelColor(value) {
  const raw = String(value || '').trim();
  return /^#[0-9a-f]{6}$/i.test(raw) ? raw.toLowerCase() : COLORS[norm(raw)] || COLORS.gray;
}

function idOf(value) {
  return String(value?.id?._serialized || value?.id || value?.labelId || value?._serialized || value || '').trim();
}

async function ensureLabel(client, target) {
  if (!client?.page?.evaluate || !target?.name) return null;
  return client.page.evaluate(async ({ name, color }) => {
    const WPP = window.WPP || null;
    if (!WPP?.labels?.getAllLabels || !WPP?.labels?.addNewLabel) {
      return { ok: false, reason: 'LABEL_API_UNAVAILABLE' };
    }
    const normalize = (value) => String(value || '').normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
    const id = (value) => String(value?.id?._serialized || value?.id || value?.labelId || value || '').trim();
    const all = async () => {
      const raw = await WPP.labels.getAllLabels();
      return Array.isArray(raw) ? raw : Object.values(raw || {});
    };

    let labels = await all();
    let item = labels.find((entry) => normalize(entry?.name || entry?.label) === normalize(name));
    if (item) return { ok: true, created: false, id: id(item), name: item?.name || name };

    let created = null;
    let reason = '';
    for (const options of [{ labelColor: color }, undefined]) {
      try {
        created = await WPP.labels.addNewLabel(name, options);
        if (created) break;
      } catch (error) {
        reason = String(error?.message || error?.text || error || 'CREATE_FAILED');
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
    labels = await all();
    item = labels.find((entry) => normalize(entry?.name || entry?.label) === normalize(name));
    return {
      ok: Boolean(item || created), created: true, id: id(item || created),
      name: item?.name || created?.name || name,
      reason: item || created ? null : reason || 'CREATE_FAILED',
    };
  }, { name: String(target.name).trim(), color: labelColor(target.color) });
}

function targets() {
  const sellers = Object.entries(env.sellerLabelRules || {}).map(([name, color]) => ({ name, color, type: 'vendedor' }));
  const values = [
    { name: env.serviceLabelLetreiro, color: env.serviceLabelLetreiroColor, type: 'serviço' },
    { name: env.serviceLabelPlotagem, color: env.serviceLabelPlotagemColor, type: 'serviço' },
    { name: env.serviceLabelOutros, color: env.serviceLabelOutrosColor, type: 'serviço' },
    { name: process.env.SERVICE_LABEL_SUPPORT || 'Suporte', color: process.env.SERVICE_LABEL_SUPPORT_COLOR || 'red', type: 'suporte' },
    ...sellers,
  ];
  const seen = new Set();
  return values.filter((item) => item.name && !seen.has(norm(item.name)) && seen.add(norm(item.name)));
}

let labelsPromise = null;
let labelsDone = false;
async function initializeLabels(channel) {
  if (!env.enableContactLabels || !channel?.client) return false;
  if (labelsDone) return true;
  if (labelsPromise) return labelsPromise;
  labelsPromise = (async () => {
    const required = targets();
    console.log(`[ETIQUETAS][INÍCIO] conferindo ${required.length} etiquetas CRM uma única vez...`);
    let ok = true;
    for (const target of required) {
      try {
        const result = await ensureLabel(channel.client, target);
        if (!result?.ok) ok = false;
        console.log(
          result?.ok
            ? `[ETIQUETAS][INÍCIO] ${result.created ? 'criada' : 'existente'} | nome="${result.name}" | ID=${result.id || '-'}`
            : `[ETIQUETAS][INÍCIO] falha | nome="${target.name}" | motivo=${result?.reason || 'sem retorno'}`,
        );
      } catch (error) {
        ok = false;
        console.error(`[ETIQUETAS][INÍCIO] erro | nome="${target.name}" |`, error?.message || error);
      }
    }
    labelsDone = true;
    return ok;
  })().finally(() => { labelsPromise = null; });
  return labelsPromise;
}

function candidates(clientId) {
  const direct = Identity.normalizeChatId(clientId);
  const known = Identity.getLabelCandidateIds?.(clientId) || [];
  return [...new Set([direct, ...known].filter(Boolean))];
}

async function applyLabel(channel, clientId, target) {
  if (!env.enableContactLabels || !channel?.client || !target?.name) return false;
  const item = await ensureLabel(channel.client, target);
  const targetId = idOf(item);
  if (!item?.ok || !targetId) return false;

  for (const chatId of candidates(clientId)) {
    try {
      const applied = await channel.client.page.evaluate(async ({ chatId: id, targetId: label }) => {
        const WPP = window.WPP || null;
        if (!WPP?.labels?.addOrRemoveLabels) return false;
        await WPP.labels.addOrRemoveLabels([id], [{ labelId: String(label), type: 'add' }]);
        return true;
      }, { chatId, targetId });
      if (applied) {
        console.log(`[ETIQUETAS] aplicada | nome="${target.name}" | ID=${targetId} | cliente=${chatId}`);
        return { applied: true, mode: 'wpp-labels', chatId, targetId, targetName: item.name || target.name };
      }
    } catch (error) {
      console.warn(`[ETIQUETAS] falha em ${chatId}:`, error?.message || error);
    }
  }
  return false;
}

function patchLabels() {
  const required = require('./requiredLabelsStartup');
  required.ensureRequiredLabelsOnce = initializeLabels;

  const service = require('./serviceLabels');
  service.initializeServiceLabels = initializeLabels;
  service.applyNamedLabel = applyLabel;
  service.replaceServiceLabel = (channel, clientId, name) => applyLabel(channel, clientId, service.getServiceLabel(name));
}

function patchCreateOptions() {
  const wppconnect = require('@wppconnect-team/wppconnect');
  if (wppconnect.__realOptionsPatched) return;
  const original = wppconnect.create.bind(wppconnect);
  const create = (options = {}) => original({
    ...options, logQR: false, updatesLog: false, disableWelcome: true,
  });
  try { wppconnect.create = create; } catch (_) {
    Object.defineProperty(wppconnect, 'create', { configurable: true, writable: true, value: create });
  }
  Object.defineProperty(wppconnect, '__realOptionsPatched', { value: true });
}

if (process.platform === 'win32'
  && !String(process.env.SESSION_ACCESS_PASSWORD || '').trim()
  && process.env.SESSION_ACCESS_AUTO_START === undefined) {
  process.env.SESSION_ACCESS_AUTO_START = 'false';
  console.log('[session-access] desativado no Windows: senha não configurada.');
}

patchConnection();
patchLabels();
patchCreateOptions();
console.log('[RUNTIME REAL] prontidão estrita, QR único e etiquetas CRM protegidos.');

module.exports = { applyLabel, ensureLabel, initializeLabels, patchConnection };
