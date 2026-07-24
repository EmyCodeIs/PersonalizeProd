'use strict';

const MenuCatalog = require('./menuCatalog');
const ServiceLabels = require('./serviceLabels');
const PreferredNote = require('./preferredSellerNotePreload');
const Reliability = require('./runtimeReliabilityPreload');
const { messages } = require('./messages');
const Store = require('../services/leadStore');
const { env } = require('../config/env');
const { normalizeText } = require('./parsers');

function clean(value) {
  return String(value || '').trim();
}

function firstLine(value) {
  return clean(value).split(/\r?\n/).map((line) => line.trim()).find(Boolean) || '';
}

function normalized(value) {
  return normalizeText(firstLine(value));
}

function isSupportRequest(value) {
  const text = normalized(value);
  if (!text) return false;

  const exact = new Set([
    'suporte',
    'serv_suporte',
    'preciso de suporte',
    'quero suporte',
    'falar com suporte',
    'atendente',
    'vendedor',
    'humano',
    'atendimento humano',
    'falar com atendente',
    'falar com vendedor',
    'falar com humano',
    'quero falar com atendente',
    'quero falar com vendedor',
    'quero falar com humano',
    'preciso falar com atendente',
    'preciso falar com vendedor',
    'preciso falar com humano',
  ]);

  if (exact.has(text)) return true;
  return /^(?:quero|preciso|gostaria)(?: de)? falar com (?:um )?(?:atendente|vendedor|humano)$/.test(text);
}

function looksLikeEncodedMedia(value = '') {
  const compact = String(value || '').replace(/\s+/g, '');
  if (compact.length < 256) return false;
  if (/^data:[^;]+;base64,/i.test(compact)) return true;
  return /^[A-Za-z0-9+/]+={0,2}$/.test(compact);
}

function safeCustomerText(value, maxLength = 1200) {
  const lines = String(value || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !looksLikeEncodedMedia(line))
    .filter((line) => !/^\[(imagem|arquivo|documento|video|vídeo|audio|áudio) enviad[oa]/i.test(line));

  const text = lines.join(' | ').replace(/\s{2,}/g, ' ').trim();
  return text ? text.slice(0, maxLength) : '';
}

function messageId(raw = {}) {
  return String(
    raw?.id?._serialized
    || raw?.id
    || raw?.messageId
    || raw?.key?.id
    || ''
  ).trim() || null;
}

function extractInboundMedia(items = []) {
  const output = [];

  for (const item of items || []) {
    const raw = item?.raw || item || {};
    const rawType = String(raw?.type || raw?.mimetype || raw?.mediaType || '').toLowerCase();
    const filename = raw?.filename || raw?.fileName || raw?.document?.filename || null;
    let type = null;

    if (/image/.test(rawType)) type = 'image';
    else if (/document|pdf|application/.test(rawType) || filename) type = 'document';
    else if (/video/.test(rawType)) type = 'video';
    else if (/audio|ptt/.test(rawType)) type = 'audio';

    if (!type) continue;
    output.push({
      type,
      filename,
      messageId: messageId(raw),
    });
  }

  const seen = new Set();
  return output.filter((item) => {
    const key = item.messageId || `${item.type}:${item.filename || ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 12);
}

function mergeMedia(current = [], incoming = []) {
  const all = [...(Array.isArray(current) ? current : []), ...(Array.isArray(incoming) ? incoming : [])];
  const seen = new Set();
  return all.filter((item) => {
    const key = item?.messageId || `${item?.type || ''}:${item?.filename || ''}`;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 12);
}

function normalizeCity(value) {
  const city = safeCustomerText(value, 140).replace(/\s*\/\s*/g, '/').trim();
  if (/^bh$/i.test(city)) return 'Belo Horizonte/MG';
  return city;
}

function observationChoice(value) {
  const text = normalized(value);
  if (text === normalizeText('OBS_PEDIDO|ADD') || /fazer observacao|adicionar detalhe/.test(text)) return 'add';
  if (text === normalizeText('OBS_PEDIDO|SKIP') || /nao preciso|sem observacao|finalizar sem/.test(text)) return 'skip';
  return null;
}

function ensureSupportMenuOption() {
  const rows = MenuCatalog?.menus?.servicos?.rows;
  if (!Array.isArray(rows)) return;
  if (rows.some((row) => row?.id === 'serv_suporte')) return;
  rows.push({
    id: 'serv_suporte',
    title: 'Suporte',
    description: 'Falar com nossa equipe sobre uma dúvida ou atendimento',
  });
}

async function enterSupport(channel, clientId, session) {
  const data = session.dados || (session.dados = {});
  const previousStage = session.etapa || null;
  const previousFlow = data.flow || null;

  session.completed = false;
  session.completedAt = null;
  session.etapa = 'suporte_coleta';
  data.botDone = false;
  data.completedAt = null;
  data.support = {
    ...(data.support || {}),
    status: 'collecting',
    requestedAt: new Date().toISOString(),
    previousStage,
    previousFlow,
    text: null,
    medias: [],
  };
  Store.saveSession(session);

  await channel.sendText(clientId, messages.supportAsk);
  console.log(`[SUPORTE] coleta iniciada | cliente=${clientId} | etapaAnterior=${previousStage || '-'} | serviço=${previousFlow || '-'}`);
  return session;
}

async function saveContactNote(channel, clientId, session) {
  if (!env.enableContactNotes || typeof channel?.setContactNote !== 'function') return false;
  PreferredNote.installPreferredSellerNoteFormatter?.(channel);
  const note = PreferredNote.buildPreferredSellerNote(session);
  return channel.setContactNote(clientId, note).catch((err) => {
    console.warn(`[NOTAS] falha ao salvar resumo em ${clientId}:`, err?.message || err);
    return false;
  });
}

async function applyLabelSafely(channel, clientId, target) {
  try { channel?.__markInternalLabelOperation?.(clientId); } catch (_) {}
  try {
    return await ServiceLabels.applyNamedLabel(channel, clientId, target);
  } catch (err) {
    console.warn(`[LISTAS] falha isolada ao aplicar "${target?.name || '-'}" em ${clientId}:`, err?.message || err);
    return false;
  } finally {
    try { channel?.__markInternalLabelOperation?.(clientId); } catch (_) {}
  }
}

async function finishServiceRequest(channel, clientId, session, reason) {
  const data = session.dados || (session.dados = {});
  const completedAt = new Date().toISOString();

  session.completed = true;
  session.etapa = 'concluido';
  data.botDone = true;
  data.completedAt = completedAt;
  Store.saveSession(session);
  Store.rememberCustomerProfile(clientId, { name: data.nome });
  Store.appendLead({ clientId: session.id || clientId, reason, etapa: session.etapa, dados: data });

  await applyLabelSafely(channel, clientId, ServiceLabels.getServiceLabel(data.flow || 'outros'));
  const noteSaved = await saveContactNote(channel, clientId, session);
  data.noteSaved = noteSaved !== false;
  data.noteUpdatedAt = new Date().toISOString();
  Store.saveSession(session);

  await channel.sendText(clientId, messages.completedContactNote);
  await channel?.markUnread?.(clientId).catch(() => false);
  console.log(`[FLUXO] ${data.flow || 'outros'} concluído | cliente=${clientId} | nota=${data.noteSaved ? 'salva' : 'falhou'}`);
  return session;
}

async function finishSupport(channel, clientId, session, args = {}) {
  const data = session.dados || (session.dados = {});
  const support = data.support || (data.support = {});
  const medias = extractInboundMedia(args.messages);
  const text = safeCustomerText(args.text, 1600);

  if (!text && !medias.length) {
    await channel.sendText(clientId, messages.supportNeedDetails);
    return session;
  }

  support.text = text || null;
  support.medias = mergeMedia(support.medias, medias);
  support.status = 'forwarded';
  support.forwardedAt = new Date().toISOString();

  session.completed = true;
  session.etapa = 'suporte_encaminhado';
  data.botDone = true;
  data.completedAt = support.forwardedAt;
  Store.saveSession(session);
  Store.rememberCustomerProfile(clientId, { name: data.nome });
  Store.appendLead({
    clientId: session.id || clientId,
    reason: 'suporte_coleta_completa',
    etapa: session.etapa,
    dados: data,
  });

  await applyLabelSafely(channel, clientId, {
    name: env.supportLabelName,
    color: env.supportLabelColor,
  });

  const noteSaved = await saveContactNote(channel, clientId, session);
  data.noteSaved = noteSaved !== false;
  data.noteUpdatedAt = new Date().toISOString();
  Store.saveSession(session);

  await channel.sendText(clientId, messages.supportForwarded);
  await channel?.markUnread?.(clientId).catch(() => false);
  console.log(`[SUPORTE] encaminhado para equipe | cliente=${clientId} | anexos=${support.medias.length} | nota=${data.noteSaved ? 'salva' : 'falhou'}`);
  return session;
}

async function askGeneralObservation(channel, clientId, session, flow) {
  session.etapa = `${flow}_observacao_menu`;
  Store.saveSession(session);
  await channel.sendText(clientId, messages.askGeneralObservation);
  await MenuCatalog.sendMenu(channel, clientId, 'observacao');
  return session;
}

function requireTextOrMedia(args, fallbackText = '') {
  const text = safeCustomerText(args.text, 1000);
  const medias = extractInboundMedia(args.messages);
  return {
    text: text || (medias.length ? fallbackText : ''),
    medias,
  };
}

ensureSupportMenuOption();

const CustomerFlow = require('../flow/customerFlow');
const originalProcessCustomerMessage = CustomerFlow.processCustomerMessage;

CustomerFlow.processCustomerMessage = async function processCustomerMessageWithSupportAndServices(args = {}) {
  const { clientId, channel } = args;
  const session = Store.getSession(clientId);
  if (!session) return originalProcessCustomerMessage(args);

  if (Reliability.isShortAcknowledgement?.(args.text)) {
    await channel?.sendText?.(clientId, '😁👍');
    console.log(`[FLUXO] agradecimento/confirmação curta reconhecida sem alterar etapa | cliente=${clientId}`);
    return session;
  }

  if (isSupportRequest(args.text)) {
    if (session.etapa === 'suporte_coleta') {
      await channel.sendText(clientId, messages.supportNeedDetails);
      return session;
    }
    return enterSupport(channel, clientId, session);
  }

  if (session.etapa === 'suporte_coleta') {
    return finishSupport(channel, clientId, session, args);
  }

  const data = session.dados || (session.dados = {});
  const demand = data.demanda || (data.demanda = {});

  if (session.etapa === 'plotagem_descricao') {
    const collected = requireTextOrMedia(args, 'Referência enviada em anexo');
    if (!collected.text && !collected.medias.length) {
      await channel.sendText(clientId, messages.askPlotagemDescricao);
      return session;
    }
    demand.descricao = collected.text;
    demand.medias = mergeMedia(demand.medias, collected.medias);
    session.etapa = 'plotagem_medida';
    Store.saveSession(session);
    await channel.sendText(clientId, messages.askPlotagemMedida);
    return session;
  }

  if (session.etapa === 'plotagem_medida') {
    const value = safeCustomerText(args.text, 250);
    if (!value) {
      await channel.sendText(clientId, messages.askPlotagemMedida);
      return session;
    }
    demand.medida = value;
    session.etapa = 'plotagem_local';
    Store.saveSession(session);
    await channel.sendText(clientId, messages.askPlotagemLocal);
    return session;
  }

  if (session.etapa === 'plotagem_local') {
    const value = safeCustomerText(args.text, 350);
    if (!value) {
      await channel.sendText(clientId, messages.askPlotagemLocal);
      return session;
    }
    demand.local = value;
    session.etapa = 'plotagem_prazo';
    Store.saveSession(session);
    await channel.sendText(clientId, messages.askPlotagemPrazo);
    return session;
  }

  if (session.etapa === 'plotagem_prazo') {
    const value = safeCustomerText(args.text, 250);
    if (!value) {
      await channel.sendText(clientId, messages.askPlotagemPrazo);
      return session;
    }
    demand.prazo = value;
    if (data.cidade) return askGeneralObservation(channel, clientId, session, 'plotagem');
    session.etapa = 'plotagem_cidade';
    Store.saveSession(session);
    await channel.sendText(clientId, messages.askCity);
    return session;
  }

  if (session.etapa === 'plotagem_cidade') {
    const city = normalizeCity(args.text);
    if (!city) {
      await channel.sendText(clientId, messages.askCity);
      return session;
    }
    data.cidade = city;
    Store.saveSession(session);
    return askGeneralObservation(channel, clientId, session, 'plotagem');
  }

  if (session.etapa === 'outros_descricao') {
    const collected = requireTextOrMedia(args, 'Referência enviada em anexo');
    if (!collected.text && !collected.medias.length) {
      await channel.sendText(clientId, messages.askOtherDescricao);
      return session;
    }
    demand.descricao = collected.text;
    demand.medias = mergeMedia(demand.medias, collected.medias);
    session.etapa = 'outros_referencia';
    Store.saveSession(session);
    await channel.sendText(clientId, messages.askOtherReferencia);
    return session;
  }

  if (session.etapa === 'outros_referencia') {
    const collected = requireTextOrMedia(args, 'Referência enviada em anexo');
    if (!collected.text && !collected.medias.length) {
      await channel.sendText(clientId, messages.askOtherReferencia);
      return session;
    }
    demand.referencia = collected.text;
    demand.medias = mergeMedia(demand.medias, collected.medias);
    session.etapa = 'outros_prazo';
    Store.saveSession(session);
    await channel.sendText(clientId, messages.askOtherPrazo);
    return session;
  }

  if (session.etapa === 'outros_prazo') {
    const value = safeCustomerText(args.text, 250);
    if (!value) {
      await channel.sendText(clientId, messages.askOtherPrazo);
      return session;
    }
    demand.prazo = value;
    if (data.cidade) return askGeneralObservation(channel, clientId, session, 'outros');
    session.etapa = 'outros_cidade';
    Store.saveSession(session);
    await channel.sendText(clientId, messages.askCity);
    return session;
  }

  if (session.etapa === 'outros_cidade') {
    const city = normalizeCity(args.text);
    if (!city) {
      await channel.sendText(clientId, messages.askCity);
      return session;
    }
    data.cidade = city;
    Store.saveSession(session);
    return askGeneralObservation(channel, clientId, session, 'outros');
  }

  if (session.etapa === 'plotagem_observacao_menu' || session.etapa === 'outros_observacao_menu') {
    const flow = session.etapa.startsWith('plotagem') ? 'plotagem' : 'outros';
    const choice = observationChoice(args.text);
    if (choice === 'skip') {
      data.observacaoPedido = null;
      Store.saveSession(session);
      return finishServiceRequest(channel, clientId, session, `${flow}_coleta_completa`);
    }
    if (choice === 'add') {
      session.etapa = `${flow}_observacao_coleta`;
      Store.saveSession(session);
      await channel.sendText(clientId, messages.askGeneralObservationText);
      return session;
    }
    await MenuCatalog.sendMenu(channel, clientId, 'observacao');
    return session;
  }

  if (session.etapa === 'plotagem_observacao_coleta' || session.etapa === 'outros_observacao_coleta') {
    const flow = session.etapa.startsWith('plotagem') ? 'plotagem' : 'outros';
    const observation = safeCustomerText(args.text, 900);
    const medias = extractInboundMedia(args.messages);
    if (!observation && !medias.length) {
      await channel.sendText(clientId, messages.askGeneralObservationText);
      return session;
    }
    data.observacaoPedido = observation || 'Cliente enviou anexo como observação.';
    demand.medias = mergeMedia(demand.medias, medias);
    Store.saveSession(session);
    return finishServiceRequest(channel, clientId, session, `${flow}_coleta_completa`);
  }

  return originalProcessCustomerMessage(args);
};

console.log('[FLUXOS] suporte global ativo | Plotagem e Outros com cidade, observação e anexos | agradecimentos=😁👍');

module.exports = {
  isSupportRequest,
  safeCustomerText,
  _test: {
    extractInboundMedia,
    normalizeCity,
    observationChoice,
  },
};
