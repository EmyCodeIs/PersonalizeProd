'use strict';

const { env } = require('../config/env');
const Identity = require('../services/contactIdentity');
const Store = require('../services/leadStore');
const { decision, decisionError } = require('./decisionLogger');

const resolvedLists = new Map();
const creationLocks = new Map();
let initializationPromise = null;
let initializationFinished = false;

const COLOR_HEX = Object.freeze({
  green: '#00a884',
  red: '#ea0038',
  gray: '#667781',
  grey: '#667781',
  blue: '#027eb5',
  yellow: '#f7b928',
  orange: '#ff7a00',
  purple: '#7f66ff',
  pink: '#ff7eb6',
});

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms || 0))));
}

function normalizeName(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function desiredHex(color) {
  const raw = String(color || '').trim();
  if (/^#[0-9a-f]{6}$/i.test(raw)) return raw.toLowerCase();
  return COLOR_HEX[normalizeName(raw)] || COLOR_HEX.gray;
}

function listId(item) {
  return String(item?.id?._serialized || item?.id || item?.labelId || '').trim();
}

function listName(item) {
  return String(item?.name || item?.label || '').trim();
}

function listCount(item) {
  const value = Number(item?.count);
  return Number.isFinite(value) ? value : 0;
}

function getServiceLabel(service) {
  if (service === 'letreiro') {
    return { name: env.serviceLabelLetreiro, color: env.serviceLabelLetreiroColor };
  }
  if (service === 'plotagem') {
    return { name: env.serviceLabelPlotagem, color: env.serviceLabelPlotagemColor };
  }
  return { name: env.serviceLabelOutros, color: env.serviceLabelOutrosColor };
}

function serviceTargets() {
  return [
    getServiceLabel('letreiro'),
    getServiceLabel('plotagem'),
    getServiceLabel('outros'),
  ].filter((item) => item?.name);
}

function managedServiceLabelNames() {
  const configured = Array.isArray(env.serviceLabelReplaceGroup)
    ? env.serviceLabelReplaceGroup
    : [];
  const fallback = serviceTargets().map((item) => item.name);
  return [...new Set((configured.length ? configured : fallback)
    .map((item) => String(item || '').trim())
    .filter(Boolean))];
}

async function readBusinessLists(client) {
  if (!client?.page?.evaluate) return [];

  try {
    return await client.page.evaluate(async () => {
      const WPP = window.WPP || null;
      if (!WPP?.labels?.getAllLabels) return [];
      const value = await WPP.labels.getAllLabels();
      const list = Array.isArray(value) ? value : Object.values(value || {});
      return list.map((item) => ({
        id: String(item?.id?._serialized || item?.id || item?.labelId || ''),
        name: String(item?.name || item?.label || ''),
        colorIndex: item?.colorIndex ?? item?.colorId ?? item?.color ?? null,
        hexColor: item?.hexColor || null,
        count: Number(item?.count || 0),
      }));
    });
  } catch (err) {
    decisionError('leitura_de_etiquetas_falhou', err);
    console.warn('[LISTAS] não foi possível ler as listas:', err?.message || err);
    return [];
  }
}

function compareIds(a, b) {
  const aId = listId(a);
  const bId = listId(b);
  const aNumber = Number(aId);
  const bNumber = Number(bId);
  if (Number.isFinite(aNumber) && Number.isFinite(bNumber)) return aNumber - bNumber;
  return aId.localeCompare(bId);
}

function findCanonicalList(items, targetName) {
  const wanted = normalizeName(targetName);
  const matches = items
    .filter((item) => normalizeName(listName(item)) === wanted)
    .filter((item) => listId(item) && listName(item));

  if (!matches.length) return null;

  const canonical = [...matches].sort((a, b) => {
    const exactA = listName(a) === String(targetName || '').trim() ? 1 : 0;
    const exactB = listName(b) === String(targetName || '').trim() ? 1 : 0;
    if (exactA !== exactB) return exactB - exactA;

    const countDifference = listCount(b) - listCount(a);
    if (countDifference) return countDifference;

    return compareIds(a, b);
  })[0];

  if (matches.length > 1) {
    console.warn(
      `[LISTAS] duplicatas de "${targetName}": ${matches.map((item) => listId(item)).join(', ')}. `
      + `Reutilizando ${listId(canonical)} sem apagar nenhuma.`,
    );
  }

  return canonical;
}

async function resolveExistingList(client, target, { refresh = false, attempts = 5, delayMs = 600 } = {}) {
  const key = normalizeName(target?.name);
  if (!key) return null;

  if (!refresh && resolvedLists.has(key)) return resolvedLists.get(key);

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const items = await readBusinessLists(client);
    const found = findCanonicalList(items, target.name);
    if (found) {
      resolvedLists.set(key, found);
      return found;
    }
    if (attempt < attempts) await wait(delayMs);
  }

  resolvedLists.delete(key);
  return null;
}

function hexToRgb(hex) {
  const clean = String(hex || '').replace('#', '');
  if (!/^[0-9a-f]{6}$/i.test(clean)) return null;
  return [
    parseInt(clean.slice(0, 2), 16),
    parseInt(clean.slice(2, 4), 16),
    parseInt(clean.slice(4, 6), 16),
  ];
}

function nearestPaletteIndex(palette, requestedHex) {
  const wanted = hexToRgb(requestedHex);
  if (!wanted || !Array.isArray(palette) || !palette.length) return null;

  let bestIndex = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  palette.forEach((entry, index) => {
    const candidateHex = typeof entry === 'string'
      ? entry
      : entry?.hex || entry?.hexColor || entry?.color || entry?.value;
    const candidate = hexToRgb(candidateHex);
    if (!candidate) return;

    const distance = ((candidate[0] - wanted[0]) ** 2)
      + ((candidate[1] - wanted[1]) ** 2)
      + ((candidate[2] - wanted[2]) ** 2);

    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  });

  return Number.isInteger(bestIndex) ? bestIndex : null;
}

async function createRealBusinessList(client, target) {
  if (!client?.page?.evaluate) return null;

  return client.page.evaluate(async ({ name, requestedHex }) => {
    const WPP = window.WPP || null;
    if (!WPP?.lists?.create || !WPP?.labels?.getAllLabels) {
      return { ok: false, reason: 'lists_api_unavailable' };
    }

    const hexToRgbInner = (hex) => {
      const clean = String(hex || '').replace('#', '');
      if (!/^[0-9a-f]{6}$/i.test(clean)) return null;
      return [
        parseInt(clean.slice(0, 2), 16),
        parseInt(clean.slice(2, 4), 16),
        parseInt(clean.slice(4, 6), 16),
      ];
    };

    const normalize = (value) => String(value || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();

    const beforeValue = await WPP.labels.getAllLabels();
    const before = Array.isArray(beforeValue) ? beforeValue : Object.values(beforeValue || {});
    const existing = before.find((item) => normalize(item?.name || item?.label) === normalize(name));
    if (existing?.id) {
      return {
        ok: true,
        existing: true,
        id: String(existing.id),
        name: String(existing.name || name),
        colorIndex: existing?.colorIndex ?? existing?.colorId ?? existing?.color ?? null,
      };
    }

    let palette = [];
    try {
      palette = WPP.labels.getLabelColorPalette
        ? await WPP.labels.getLabelColorPalette()
        : [];
    } catch (_) {}

    const wanted = hexToRgbInner(requestedHex);
    let colorIndex = null;
    let bestDistance = Number.POSITIVE_INFINITY;

    if (wanted && Array.isArray(palette)) {
      palette.forEach((entry, index) => {
        const candidateHex = typeof entry === 'string'
          ? entry
          : entry?.hex || entry?.hexColor || entry?.color || entry?.value;
        const candidate = hexToRgbInner(candidateHex);
        if (!candidate) return;
        const distance = ((candidate[0] - wanted[0]) ** 2)
          + ((candidate[1] - wanted[1]) ** 2)
          + ((candidate[2] - wanted[2]) ** 2);
        if (distance < bestDistance) {
          bestDistance = distance;
          colorIndex = index;
        }
      });
    }

    const attempts = [];
    if (Number.isInteger(colorIndex)) attempts.push(colorIndex);
    attempts.push(undefined);

    let createdId = '';
    let lastError = '';

    for (const requestedIndex of attempts) {
      try {
        createdId = String(await WPP.lists.create(name, [], requestedIndex));
        if (createdId) break;
      } catch (err) {
        lastError = String(err?.message || err?.text || err || '');
      }
    }

    if (!createdId) {
      return {
        ok: false,
        reason: 'create_failed',
        error: lastError,
        colorIndex,
        palette,
      };
    }

    await new Promise((resolve) => setTimeout(resolve, 1400));

    const afterValue = await WPP.labels.getAllLabels();
    const after = Array.isArray(afterValue) ? afterValue : Object.values(afterValue || {});
    const found = after.find((item) => String(item?.id || item?.labelId || '') === createdId)
      || after.find((item) => normalize(item?.name || item?.label) === normalize(name));

    return {
      ok: Boolean(found?.id || createdId),
      id: String(found?.id || found?.labelId || createdId),
      name: String(found?.name || found?.label || name),
      colorIndex: found?.colorIndex ?? found?.colorId ?? found?.color ?? colorIndex ?? null,
      requestedColorIndex: colorIndex,
      paletteColor: Number.isInteger(colorIndex) ? palette[colorIndex] : null,
      paletteSize: Array.isArray(palette) ? palette.length : 0,
    };
  }, {
    name: String(target.name || '').trim(),
    requestedHex: desiredHex(target.color),
  });
}

async function ensureServiceList(client, target) {
  const key = normalizeName(target?.name);
  if (!key) return null;

  const existing = await resolveExistingList(client, target, {
    refresh: true,
    attempts: 4,
    delayMs: 600,
  });
  if (existing) {
    decision('ETIQUETA', 'localizada', { etiqueta: listName(existing), id: listId(existing), resultado: 'reutilizada' });
    console.log(`[LISTAS] reutilizando: ${listName(existing)} | ID ${listId(existing)}`);
    return existing;
  }

  if (creationLocks.has(key)) return creationLocks.get(key);

  const task = (async () => {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const confirmed = await resolveExistingList(client, target, {
        refresh: true,
        attempts: 2,
        delayMs: 500,
      });
      if (confirmed) return confirmed;

      decision('ETIQUETA', 'criação_tentada', { etiqueta: target.name, cor: target.color, tentativa: `${attempt}/3` });
      console.log(`[LISTAS] criação ${attempt}/3: ${target.name} | cor=${target.color} | hex=${desiredHex(target.color)}`);

      let created = null;
      try {
        created = await createRealBusinessList(client, target);
      } catch (err) {
        decisionError('criação_de_etiqueta_falhou', err, { etiqueta: target.name, tentativa: `${attempt}/3` });
        console.warn(`[LISTAS] erro ao criar "${target.name}":`, err?.message || err);
      }

      if (created?.ok) {
        decision('ETIQUETA', 'criada', { etiqueta: created.name, id: created.id, confirmado: true });
        console.log(
          `[LISTAS] criada: ${created.name} | ID ${created.id} | `
          + `índice solicitado=${String(created.requestedColorIndex)} | índice final=${String(created.colorIndex)}`,
        );
        await wait(1800);
        const refreshed = await resolveExistingList(client, target, {
          refresh: true,
          attempts: 8,
          delayMs: 700,
        });
        if (refreshed) return refreshed;
      } else {
        decision('ETIQUETA', 'criação_não_confirmada', {
          etiqueta: target.name,
          tentativa: `${attempt}/3`,
          motivo: created?.reason || 'sem_retorno',
        }, 'warn');
        console.warn(
          `[LISTAS] tentativa ${attempt} falhou para "${target.name}": `
          + `${created?.reason || 'sem retorno'} ${created?.error || ''}`.trim(),
        );
      }

      await wait(2200);
    }

    return null;
  })().finally(() => {
    creationLocks.delete(key);
  });

  creationLocks.set(key, task);
  return task;
}

async function initializeServiceLabels(channel) {
  if (!env.enableContactLabels || !channel?.client) return false;
  if (initializationFinished) return true;
  if (initializationPromise) return initializationPromise;

  initializationPromise = (async () => {
    decision('ETIQUETA', 'manutenção_iniciada', { quantidade: serviceTargets().length });
    console.log('[LISTAS] verificando e criando separadamente as listas de atendimento...');
    await wait(1500);

    let ready = true;
    for (const target of serviceTargets()) {
      const item = await ensureServiceList(channel.client, target);
      if (!item) {
        ready = false;
        decision('ETIQUETA', 'ausente', { etiqueta: target.name, confirmado: false }, 'warn');
        console.warn(`[LISTAS] AUSENTE após 3 tentativas: ${target.name}`);
      } else {
        decision('ETIQUETA', 'pronta', { etiqueta: listName(item), id: listId(item), cor: target.color, confirmado: true });
        console.log(`[LISTAS] PRONTA: ${listName(item)} | ID ${listId(item)} | cor=${target.color}`);
      }
      await wait(1600);
    }

    initializationFinished = true;
    decision('ETIQUETA', 'manutenção_concluída', { resultado: ready ? 'ok' : 'parcial' });
    return ready;
  })().finally(() => {
    initializationPromise = null;
  });

  return initializationPromise;
}

async function inspectChatLists(client, chatId) {
  if (!client?.page?.evaluate || !chatId) {
    return { available: false, chatFound: null, items: [] };
  }

  try {
    return await client.page.evaluate(async ({ chatId }) => {
      const WPP = window.WPP || null;
      const Store = window.Store || null;
      let chat = null;

      try {
        chat = Store?.Chat?.get?.(chatId) || null;
        if (!chat && typeof Store?.Chat?.find === 'function') chat = await Store.Chat.find(chatId);
      } catch (_) {}

      if (!chat) return { available: true, chatFound: false, items: [] };

      let all = [];
      try {
        if (WPP?.labels?.getAllLabels) {
          const value = await WPP.labels.getAllLabels();
          all = Array.isArray(value) ? value : Object.values(value || {});
        }
      } catch (_) {}

      const labelStore = Store?.Label || Store?.Labels || null;
      if (typeof labelStore?.getLabelsForModel !== 'function') {
        return { available: false, chatFound: true, items: [] };
      }

      let attached = [];
      try {
        const value = labelStore.getLabelsForModel(chat) || [];
        attached = Array.isArray(value) ? value : Object.values(value || {});
      } catch (_) {}

      const items = attached.map((entry) => {
        const id = String(entry?.id?._serialized || entry?.id || entry?.labelId || entry || '');
        const known = all.find((item) => String(item?.id || item?.labelId || '') === id) || null;
        return {
          id,
          name: String(entry?.name || entry?.label || known?.name || known?.label || ''),
          colorIndex: entry?.colorIndex ?? entry?.colorId ?? entry?.color
            ?? known?.colorIndex ?? known?.colorId ?? known?.color ?? null,
        };
      }).filter((item) => item.id);

      return { available: true, chatFound: true, items };
    }, { chatId });
  } catch (err) {
    console.warn(`[LISTAS] não foi possível verificar ${chatId}:`, err?.message || err);
    return { available: false, chatFound: null, items: [] };
  }
}

function persistManualLists(clientId, items = []) {
  if (!env.storeManualContactLabels) return;

  try {
    const managed = new Set(managedServiceLabelNames().map(normalizeName));
    const manual = items
      .filter((item) => item?.name && !managed.has(normalizeName(item.name)))
      .map((item) => ({
        id: String(item.id || ''),
        name: String(item.name || '').trim(),
        colorIndex: Number.isFinite(Number(item.colorIndex)) ? Number(item.colorIndex) : null,
      }))
      .filter((item, index, list) => item.name
        && list.findIndex((candidate) => candidate.id === item.id && candidate.name === item.name) === index)
      .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));

    const session = Store.getSession(clientId);
    if (!session) return;
    session.dados = session.dados || {};
    session.dados.manualContactLabels = manual;
    session.dados.manualContactLabelNames = manual.map((item) => item.name);
    session.dados.manualContactLabelsDetectedAt = new Date().toISOString();
    Store.saveSession(session);
  } catch (err) {
    console.warn('[LISTAS] não foi possível registrar listas manuais:', err?.message || err);
  }
}

async function addChatToList(client, chatId, targetId) {
  if (!client?.page?.evaluate) return { submitted: false, mode: 'unavailable' };

  try {
    return await client.page.evaluate(async ({ chatId, targetId }) => {
      const WPP = window.WPP || null;
      if (WPP?.lists?.addChats) {
        await WPP.lists.addChats(String(targetId), [chatId]);
        return { submitted: true, mode: 'wpp-lists' };
      }
      if (WPP?.labels?.addOrRemoveLabels) {
        await WPP.labels.addOrRemoveLabels(
          [chatId],
          [{ labelId: String(targetId), type: 'add' }],
        );
        return { submitted: true, mode: 'wpp-labels-fallback' };
      }
      return { submitted: false, mode: 'unavailable' };
    }, { chatId, targetId: String(targetId) });
  } catch (err) {
    return { submitted: false, mode: 'error', error: String(err?.message || err) };
  }
}

function orderedCandidateIds(clientId) {
  const direct = Identity.normalizeChatId(clientId);
  const known = Identity.getLabelCandidateIds(clientId);
  return [...new Set([direct, ...known].filter(Boolean))];
}

async function applyListToCandidates(client, clientId, item) {
  const targetId = listId(item);
  const candidates = orderedCandidateIds(clientId);
  const unverified = [];

  for (const chatId of candidates) {
    const before = await inspectChatLists(client, chatId);
    if (before.chatFound === false && candidates.length > 1) continue;

    persistManualLists(clientId, before.items);

    if (before.items.some((entry) => String(entry.id) === targetId)) {
      return { applied: true, verified: true, alreadyAttached: true, mode: 'existing', chatId };
    }

    const operation = await addChatToList(client, chatId, targetId);
    if (!operation.submitted) {
      if (operation.error) console.warn(`[LISTAS] falha ao incluir ${chatId}: ${operation.error}`);
      continue;
    }

    await wait(1000);
    const after = await inspectChatLists(client, chatId);
    persistManualLists(clientId, after.items.length ? after.items : before.items);

    if (after.items.some((entry) => String(entry.id) === targetId)) {
      return { applied: true, verified: true, mode: operation.mode, chatId };
    }

    if (after.available && after.chatFound) continue;
    unverified.push({ chatId, mode: operation.mode });
  }

  if (unverified.length) {
    return {
      applied: true,
      verified: null,
      chatId: unverified[0].chatId,
      mode: unverified[0].mode,
    };
  }

  return { applied: false, verified: false };
}

async function applyNamedLabel(channel, clientId, target) {
  if (!env.enableContactLabels || !channel?.client || !target?.name) return false;
  decision('ETIQUETA', 'alvo_resolvido', { chat: clientId, etiqueta: target.name, cor: target.color || '-' });

  const client = channel.client;
  let item = await resolveExistingList(client, target);
  if (!item) item = await ensureServiceList(client, target);

  if (!item) {
    decision('ETIQUETA', 'não_localizada', { chat: clientId, etiqueta: target.name, motivo: 'create_or_find_failed' }, 'warn');
    console.warn(`[LISTAS] não foi possível criar ou localizar "${target.name}".`);
    return false;
  }

  const result = await applyListToCandidates(client, clientId, item);
  if (!result?.applied) {
    decision('ETIQUETA', 'aplicação_falhou', { chat: clientId, etiqueta: target.name, confirmado: false }, 'warn');
    console.warn(`[LISTAS] não foi possível incluir o contato em "${target.name}".`);
    return false;
  }

  decision('ETIQUETA', 'aplicada', {
    chat: result.chatId || clientId,
    etiqueta: listName(item),
    id: listId(item),
    modo: result.mode,
    confirmado: result.verified === true,
    verificação: result.verified === null ? 'indisponível' : String(result.verified),
  });
  console.log(
    `[LISTAS] aplicada sem remover outras: ${listName(item)} | ID ${listId(item)} `
    + `| ${result.chatId} | modo=${result.mode} | verificada=${String(result.verified)}`,
  );

  return {
    ...result,
    targetId: listId(item),
    targetName: listName(item),
  };
}

async function replaceServiceLabel(channel, clientId, service) {
  return applyNamedLabel(channel, clientId, getServiceLabel(service));
}

module.exports = {
  initializeServiceLabels,
  replaceServiceLabel,
  applyNamedLabel,
  managedServiceLabelNames,
  getServiceLabel,
  normalizeChatId: Identity.normalizeChatId,
  _test: {
    desiredHex,
    findCanonicalLabel: findCanonicalList,
    listId,
    listName,
    nearestPaletteIndex,
    normalizeName,
    orderedCandidateIds,
  },
};
