'use strict';

const { messages } = require('../core/messages');
const {
  sendMenu, buildColorTypeMenu, buildSolidColorMenu, buildMirrorColorMenu,
  buildDepthMenu, buildDeliveryMenu,
} = require('../core/menuCatalog');
const {
  sendTabelaCores, sendTabelaEspessura, sendTabelaProfundidade,
} = require('../core/mostruario');
const { sendMostruarioCatalog } = require('../core/catalogMostruarioPreload');
const { replaceServiceLabel } = require('../core/serviceLabels');
const { detectInitialContext } = require('../core/intent');
const { parseMedidasFromText, normalizeText, extractName, extractPhone } = require('../core/parsers');
const {
  buildBaseThicknessMessage, buildBaseThicknessLabel,
  buildBaseThicknessSnapshot, buildExtraThicknessMessage,
} = require('../domain/acrilicoThickness');
const Store = require('../services/leadStore');
const { env } = require('../config/env');

const SOLID = new Map([
  ['cor_preto', 'Preto'], ['cor_branco', 'Branco'], ['cor_cinza', 'Cinza'],
  ['cor_azul', 'Azul'], ['cor_verde', 'Verde'], ['cor_vermelho', 'Vermelho'],
  ['cor_amarelo', 'Amarelo'],
]);
const MIRROR = new Map([
  ['cor_dourado', 'Dourado'], ['cor_prata', 'Prata'], ['cor_rose', 'Rosê'],
  ['cor_esp_vermelho', 'Vermelho espelhado'], ['cor_esp_verde', 'Verde espelhado'],
  ['cor_esp_azul', 'Azul espelhado'], ['cor_esp_roxo', 'Roxo espelhado'],
]);

const clean = (v) => String(v || '').trim();
const first = (v) => clean(v).split(/\r?\n/).map((x) => x.trim()).find(Boolean) || '';
const norm = (v) => normalizeText(first(v));
const isBack = (v, ...ids) => norm(v) === 'voltar' || ids.map(normalizeText).includes(norm(v));

function serviceOf(v) {
  const x = norm(v);
  if (['serv_letreiro', '1', 'letreiro', 'letreiro de acrilico'].includes(x) || /\bletreiro\b/.test(x)) return 'letreiro';
  if (['serv_plotagem', '2', 'plotagem'].includes(x)) return 'plotagem';
  if (['serv_outros', '3', 'outro', 'outros'].includes(x)) return 'outros';
  return null;
}
function acrylicOf(v) {
  const x = norm(v);
  if (x === 'acr_colorido' || /colorido|cor solida|cores solidas/.test(x)) return 'colorido';
  if (x === 'acr_pintado' || /personalizado|pantone|pintado/.test(x)) return 'pintado';
  return null;
}
function quantityOf(v) {
  const x = norm(v);
  const m = x.match(/^corq_([1-5])$/) || x.match(/^([1-5])\s*cor(?:es)?$/) || x.match(/^([1-5])$/);
  return m ? Number(m[1]) : null;
}
function colorTypeOf(v) {
  const x = norm(v);
  if (['cor_tipo_solida', 'cor solida', 'solida'].includes(x)) return 'solida';
  if (['cor_tipo_espelhado', 'cor espelhada', 'espelhada', 'espelhado'].includes(x)) return 'espelhada';
  return null;
}
function colorOf(v, type) {
  const x = norm(v);
  for (const [id, label] of (type === 'espelhada' ? MIRROR : SOLID)) {
    if (x === normalizeText(id) || x === normalizeText(label)) return label;
  }
  return null;
}
function personalizedThicknessOf(v) {
  const x = norm(v);
  if (['esp_4', '4mm', 'quero 4mm'].includes(x)) return '4mm';
  if (['esp_6', '6mm', 'quero 6mm'].includes(x)) return '6mm';
  if (['esp_10', '10mm', 'quero 10mm'].includes(x)) return '10mm';
  if (x === 'esp_nao_sei' || /ainda nao sei|definir depois/.test(x)) return 'a definir';
  return null;
}
function depthOf(v) {
  const x = norm(v);
  if (x === 'esp3_keep' || /manter|seguir com|sem acrescimo/.test(x)) return ['keep', '0mm'];
  if (x === 'esp3_add3' || /\+?\s*3mm|adicionar 3|acrescentar 3/.test(x)) return ['extra', '3mm'];
  if (x === 'esp3_add6' || /\+?\s*6mm|adicionar 6|acrescentar 6/.test(x)) return ['extra', '6mm'];
  if (x === 'esp3_add10' || /\+?\s*10mm|adicionar 10|acrescentar 10/.test(x)) return ['extra', '10mm'];
  if (x === 'esp3_align' || /ainda nao sei|definir depois/.test(x)) return ['align', null];
  return null;
}
function isGrandeBH(city) {
  const x = normalizeText(city);
  if (!x) return false;
  if (/\bbh\b/.test(x) || x.includes('belo horizonte')) return true;
  return ['contagem', 'betim', 'nova lima', 'ribeirao das neves', 'santa luzia',
    'vespasiano', 'ibirite', 'sabara', 'lagoa santa', 'raposos', 'brumadinho',
    'sarzedo', 'mateus leme', 'pedro leopoldo', 'confins', 'sao jose da lapa']
    .some((name) => x.includes(name));
}
function sanitizeObservation(v) {
  return String(v || '').replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, 1200);
}
function mediaSummary(items = []) {
  const out = [];
  for (const item of items) {
    const raw = item?.raw || item || {};
    const type = String(raw.type || raw.mimetype || raw.mediaType || '').toLowerCase();
    const filename = raw.filename || raw.fileName || raw.document?.filename || null;
    const caption = raw.caption || raw.body || null;
    if (/image/.test(type)) out.push({ type: 'image', filename, caption });
    else if (/document|pdf|application/.test(type) || filename) out.push({ type: 'document', filename: filename || 'arquivo', caption });
    else if (/video/.test(type)) out.push({ type: 'video', filename, caption });
  }
  return out.slice(0, 10);
}
function formatMeasure(d) {
  const m = d.medida || {};
  if (d.tamanhoModo === 'completo') return `${m.largura} x ${m.altura} cm`;
  if (d.tamanhoModo === 'largura') return `${m.largura} cm de largura; altura proporcional à arte`;
  if (d.tamanhoModo === 'altura') return `${m.altura} cm de altura; largura proporcional à arte`;
  return d.tamanhoDescricao || 'Não definida';
}
function buildBusinessNote(session, reason = 'atendimento_concluido') {
  const d = session.dados || {};
  const q = d.demanda || {};
  const media = d.arteMedias?.length ? d.arteMedias.map((m) => `${m.type}${m.filename ? `: ${m.filename}` : ''}`).join(', ') : null;
  return [
    '🟢 Atendimento coletado pelo Bot WPPConnect', `Status: ${reason}`,
    `Atualizado em: ${new Date().toLocaleString('pt-BR')}`,
    d.origem && `Origem: ${d.origem}`, d.nome && `Nome: ${d.nome}`,
    d.telefone && `Telefone: ${d.telefone}`, d.flow && `Serviço: ${d.flow}`,
    q.descricao && `Demanda: ${q.descricao}`, q.medida && `Medida informada: ${q.medida}`,
    q.local && `Local/aplicação: ${q.local}`, q.referencia && `Referência/detalhes: ${q.referencia}`,
    q.prazo && `Prazo: ${q.prazo}`,
    d.tipoAcrilico && `Tipo de acrílico: ${d.tipoAcrilico === 'pintado' ? 'Personalizado/Pantone' : 'Colorido'}`,
    d.pantoneDescricao && `Pantone/cor personalizada: ${d.pantoneDescricao}`,
    d.corBasicaQtd && `Quantidade de cores: ${d.corBasicaQtd}`,
    d.coresSelecionadas?.length && `Cores: ${d.coresSelecionadas.join(', ')}`,
    d.espessuraBaseDescricao && `Espessura base: ${d.espessuraBaseDescricao.replace(/^🔎\s*Observação:\s*/i, '')}`,
    d.acrescimoAcrilico && d.acrescimoAcrilico !== '0mm' && `Acrílico cristal extra: +${d.acrescimoAcrilico}`,
    d.acrescimoAcrilicoAAlinhar && 'Acréscimo de espessura: a definir',
    d.tipoAcrilico === 'pintado' && d.espessura && `Espessura: ${d.espessura}`,
    d.medida && `Medida do letreiro: ${formatMeasure(d)}`,
    d.arteModo && `Arte: ${d.arteModo}`, d.arteTexto && `Descrição da arte: ${d.arteTexto}`,
    media && `Arquivos/referências recebidos: ${media}`, d.cidade && `Cidade: ${d.cidade}`,
    d.envio && `Forma de recebimento: ${d.envio}`, d.endereco && `Endereço: ${d.endereco}`,
    d.observacaoPedido && `Observação do cliente: ${d.observacaoPedido}`,
  ].filter(Boolean).join('\n');
}
async function finish(channel, clientId, session, reason) {
  session.completed = true;
  session.etapa = 'concluido';
  session.dados.botDone = true;
  session.dados.completedAt = new Date().toISOString();
  Store.saveSession(session);
  Store.rememberCustomerProfile(clientId, { name: session.dados?.nome });
  Store.appendLead({ clientId: session.id, reason, etapa: session.etapa, dados: session.dados });
  await replaceServiceLabel(channel, clientId, session.dados.flow || 'outros').catch(() => null);
  if (env.enableContactNotes && channel?.setContactNote) {
    const ok = await channel.setContactNote(clientId, buildBusinessNote(session, reason)).catch(() => false);
    session.dados.noteSaved = ok !== false;
    session.dados.noteUpdatedAt = new Date().toISOString();
    Store.saveSession(session);
  }
  await channel.sendText(clientId, messages.completedContactNote);
  await channel?.markUnread?.(clientId).catch(() => false);
  return session;
}

async function startMeasure(channel, id, s) {
  s.dados.medida = null; s.dados.tamanhoModo = null; s.dados.tamanhoDescricao = null;
  s.etapa = 'tamanho'; Store.saveSession(s); await channel.sendText(id, messages.askMeasure);
}
async function toThickness(channel, id, s) {
  if (s.dados.tipoAcrilico === 'colorido') {
    s.etapa = 'espessura_extra_3mm'; Store.saveSession(s);
    await sendTabelaProfundidade(channel, id);
    await sendMenu(channel, id, buildDepthMenu(s.dados.coresSelecionadas || []));
  } else {
    s.etapa = 'espessura_personalizada'; Store.saveSession(s);
    await sendTabelaEspessura(channel, id); await sendMenu(channel, id, 'espessuraPersonalizada');
  }
}
async function startArt(channel, id, s) {
  s.etapa = 'arte_coleta';
  s.dados.arteModo = 'livre';
  s.dados.arteTexto = null;
  s.dados.arteMedias = [];
  s.dados.arte = null;
  Store.saveSession(s);
  await channel.sendText(id, messages.askArtQuestion);
  await channel.sendText(id, messages.askArtExplanation);
  await channel.sendText(id, messages.askArtFree);
}
async function startCity(channel, id, s) { s.etapa = 'cidade'; Store.saveSession(s); await channel.sendText(id, messages.askCity); }
async function startDelivery(channel, id, s) {
  s.etapa = 'envio'; Store.saveSession(s);
  await channel.sendText(id, 'Qual a melhor forma pra te enviarmos seu pedido?');
  await sendMenu(channel, id, buildDeliveryMenu(isGrandeBH(s.dados.cidade)));
}
async function finishColor(channel, id, s, color) {
  const d = s.dados;
  const total = Math.max(1, Math.min(5, Number(d.corBasicaQtd || 1)));
  if (!Array.isArray(d.coresSelecionadas)) d.coresSelecionadas = [];
  if (d.coresSelecionadas.length >= total) d.coresSelecionadas = [];
  d.coresSelecionadas.push(color);
  const count = d.coresSelecionadas.length;
  d.corUnica = total === 1 ? color : null;
  if (count < total) {
    d.corBasicaIndex = count + 1; s.etapa = 'cor_basica_tipo'; Store.saveSession(s);
    await channel.sendText(id, `Cor ${count} de ${total} anotada: ${color}.`);
    await sendMenu(channel, id, buildColorTypeMenu(count + 1, total));
    return s;
  }
  d.coresSelecionadas = d.coresSelecionadas.slice(0, total);
  d.corBasicaIndex = total;
  d.espessuraBaseCores = buildBaseThicknessSnapshot(d.coresSelecionadas);
  d.espessuraBaseDescricao = buildBaseThicknessMessage(d.coresSelecionadas);
  d.espessuraBaseLabel = buildBaseThicknessLabel(d.coresSelecionadas);
  d.espessura = d.espessuraBaseLabel; d.acrescimoAcrilico = null; d.acrescimoAcrilicoAAlinhar = false;
  Store.saveSession(s);
  await channel.sendText(id, total === 1 ? `Cor anotada: ${color}.` : `Cores anotadas: ${d.coresSelecionadas.join(', ')}.`);
  await channel.sendText(id, d.espessuraBaseDescricao);
  await startMeasure(channel, id, s);
  return s;
}

async function processCustomerMessage({ clientId, text, channel, messages: inbound = [] }) {
  const s = Store.getSession(clientId);
  const input = clean(text);
  if (!s || !input) return s;

  const d = s.dados || (s.dados = {});
  const foundName = extractName(input), foundPhone = extractPhone(input);
  if (foundName && !d.nome) d.nome = foundName;
  if (foundPhone && !d.telefone) d.telefone = foundPhone;
  if (d.botDone || s.completed) {
    await channel.sendText(clientId, 'Seu atendimento já foi registrado na sua ficha de contato. Para começar novamente, use */reset* durante os testes.');
    return s;
  }

  if (s.etapa === 'inicio') {
    const initial = detectInitialContext(input);
    d.initial = initial; d.origem = initial.isLanding ? 'landing/site' : 'whatsapp';
    if (initial.name && !d.nome) d.nome = initial.name;
    if (initial.phone && !d.telefone) d.telefone = initial.phone;
    const visit = Store.beginCustomerConversation(clientId, { name: d.nome });
    await channel.sendText(clientId, messages.welcome(d.nome, { isReturning: visit.isReturning }));
    s.etapa = 'escolher_servico'; Store.saveSession(s); await sendMenu(channel, clientId, 'servicos'); return s;
  }

  if (s.etapa === 'escolher_servico') {
    const service = serviceOf(input);
    if (!service) { await sendMenu(channel, clientId, 'servicos'); return s; }
    d.flow = service; d.demanda = {};
    await replaceServiceLabel(channel, clientId, service).catch(() => null);
    if (service === 'letreiro') {
      s.etapa = 'tipo_acrilico';
      Store.saveSession(s);
      await sendMostruarioCatalog(channel, clientId);
      await channel.sendText(clientId, messages.letteringBudgetIntro);
      console.log(
        `[FLUXO][LETREIRO] catálogo enviado e explicação exibida | cliente=${clientId} `
        + '| próximaEtapa=tipo_acrilico',
      );
      await sendMenu(channel, clientId, 'tipoAcrilico');
      return s;
    }
    s.etapa = service === 'plotagem' ? 'plotagem_descricao' : 'outros_descricao'; Store.saveSession(s);
    await channel.sendText(clientId, service === 'plotagem' ? messages.plotagem : messages.otherService);
    await channel.sendText(clientId, service === 'plotagem' ? messages.askPlotagemDescricao : messages.askOtherDescricao);
    return s;
  }

  if (s.etapa === 'tipo_acrilico') {
    const type = acrylicOf(input);
    if (!type) { await sendMenu(channel, clientId, 'tipoAcrilico'); return s; }
    Object.assign(d, { tipoAcrilico: type, coresSelecionadas: [], corUnica: null, corBasicaQtd: null,
      corBasicaIndex: null, acrescimoAcrilico: null, acrescimoAcrilicoAAlinhar: false,
      espessuraBaseCores: [], espessuraBaseDescricao: null, espessuraBaseLabel: null });
    if (type === 'pintado') {
      d.tipoCor = 'pantone'; s.etapa = 'pantone'; Store.saveSession(s);
      await channel.sendText(clientId, messages.askPantone); return s;
    }
    d.tipoCor = 'prontas'; s.etapa = 'cor_basica_qtd'; Store.saveSession(s);
    await sendTabelaCores(channel, clientId); await sendMenu(channel, clientId, 'quantidadeCores'); return s;
  }

  if (s.etapa === 'pantone') {
    d.pantoneDescricao = input; d.pantoneMedias = mediaSummary(inbound); Store.saveSession(s);
    await startMeasure(channel, clientId, s); return s;
  }
  if (s.etapa === 'cor_basica_qtd') {
    if (isBack(input, 'corq_voltar')) { s.etapa = 'tipo_acrilico'; d.tipoAcrilico = null; d.tipoCor = null; Store.saveSession(s); await sendMenu(channel, clientId, 'tipoAcrilico'); return s; }
    const q = quantityOf(input);
    if (!q) { await sendMenu(channel, clientId, 'quantidadeCores'); return s; }
    d.corBasicaQtd = q; d.corBasicaIndex = 1; d.coresSelecionadas = []; d.corUnica = null;
    s.etapa = 'cor_basica_tipo'; Store.saveSession(s); await sendMenu(channel, clientId, buildColorTypeMenu(1, q)); return s;
  }
  if (s.etapa === 'cor_basica_tipo') {
    if (isBack(input, 'cor_tipo_voltar')) { s.etapa = 'cor_basica_qtd'; Store.saveSession(s); await sendMenu(channel, clientId, 'quantidadeCores'); return s; }
    const type = colorTypeOf(input), total = Math.max(1, Number(d.corBasicaQtd || 1));
    const index = Math.min(total, (d.coresSelecionadas?.length || 0) + 1);
    if (type === 'solida') { s.etapa = 'cor_basica_select_solida'; d.corBasicaIndex = index; Store.saveSession(s); await sendMenu(channel, clientId, buildSolidColorMenu(index, total)); return s; }
    if (type === 'espelhada') { s.etapa = 'cor_basica_select_espelhado'; d.corBasicaIndex = index; Store.saveSession(s); await sendMenu(channel, clientId, buildMirrorColorMenu(index, total)); return s; }
    await sendMenu(channel, clientId, buildColorTypeMenu(index, total)); return s;
  }
  if (s.etapa === 'cor_basica_select_solida' || s.etapa === 'cor_basica_select_espelhado') {
    const type = s.etapa.endsWith('espelhado') ? 'espelhada' : 'solida';
    const total = Math.max(1, Number(d.corBasicaQtd || 1)), index = Math.min(total, (d.coresSelecionadas?.length || 0) + 1);
    if (isBack(input, 'cor_voltar')) { s.etapa = 'cor_basica_tipo'; Store.saveSession(s); await sendMenu(channel, clientId, buildColorTypeMenu(index, total)); return s; }
    const color = colorOf(input, type);
    if (!color) { await sendMenu(channel, clientId, type === 'espelhada' ? buildMirrorColorMenu(index, total) : buildSolidColorMenu(index, total)); return s; }
    return finishColor(channel, clientId, s, color);
  }

  if (s.etapa === 'tamanho') {
    const p = parseMedidasFromText(input, { largura: null, altura: null });
    if (p.modo === 'pedir_descricao') { await channel.sendText(clientId, messages.askMeasureDescription); return s; }
    if (p.modo === 'invalido') { await channel.sendText(clientId, messages.invalidMeasure); return s; }
    d.medida = { largura: p.largura ?? null, altura: p.altura ?? null }; d.tamanhoModo = p.modo; d.tamanhoDescricao = p.descricao || null; Store.saveSession(s);
    if (p.modo === 'descricao') await channel.sendText(clientId, 'Beleza! Vou registrar essa descrição como referência de proporção para a arte.');
    else if (p.modo === 'altura') await channel.sendText(clientId, `Entendi ${p.altura} cm de altura. A outra medida será ajustada proporcionalmente à arte.`);
    else if (p.modo === 'largura') await channel.sendText(clientId, `Entendi ${p.largura} cm de largura. A outra medida será ajustada proporcionalmente à arte.`);
    else await channel.sendText(clientId, `Medida anotada: ${p.largura} x ${p.altura} cm.`);
    await toThickness(channel, clientId, s); return s;
  }
  if (s.etapa === 'espessura_extra_3mm') {
    if (isBack(input, 'esp3_back')) { d.acrescimoAcrilico = null; await startMeasure(channel, clientId, s); return s; }
    const depth = depthOf(input);
    if (!depth) { await sendMenu(channel, clientId, buildDepthMenu(d.coresSelecionadas || [])); return s; }
    const [kind, extra] = depth;
    if (kind === 'keep') { d.acrescimoAcrilico = '0mm'; d.acrescimoAcrilicoAAlinhar = false; }
    else if (kind === 'extra') { d.acrescimoAcrilico = extra; d.acrescimoAcrilicoAAlinhar = false; await channel.sendText(clientId, buildExtraThicknessMessage(d.coresSelecionadas || [], extra)); }
    else { d.acrescimoAcrilico = null; d.acrescimoAcrilicoAAlinhar = true; await channel.sendText(clientId, 'Certo! Registrei o acréscimo de espessura como *a definir*.'); }
    d.espessura = d.espessuraBaseLabel || buildBaseThicknessLabel(d.coresSelecionadas || []); Store.saveSession(s); await startArt(channel, clientId, s); return s;
  }
  if (s.etapa === 'espessura_personalizada') {
    if (isBack(input, 'esp_voltar')) { await startMeasure(channel, clientId, s); return s; }
    const t = personalizedThicknessOf(input);
    if (!t) { await sendMenu(channel, clientId, 'espessuraPersonalizada'); return s; }
    d.espessura = t; d.espessuraAAlinhar = t === 'a definir'; Store.saveSession(s);
    await channel.sendText(clientId, t === 'a definir' ? 'Certo! Registrei a espessura como *a definir*.' : `Espessura anotada: ${t}.`);
    await startArt(channel, clientId, s); return s;
  }

  if (s.etapa === 'arte_coleta') {
    const medias = mediaSummary(inbound);
    const description = input.split(/\r?\n/).map((x) => x.trim()).filter(Boolean)
      .filter((x) => !/^\[(imagem|arquivo|documento|video) enviado/i.test(x)).join(' | ').trim();
    if (!description && !medias.length) { await channel.sendText(clientId, messages.askArtFree); return s; }
    d.arteModo = 'livre'; d.arteTexto = description || null; d.arteMedias = medias;
    d.arte = { modo: 'livre', texto: d.arteTexto, medias }; Store.saveSession(s);
    await channel.sendText(clientId, 'Arte e referências anotadas!'); await startCity(channel, clientId, s); return s;
  }
  if (s.etapa === 'cidade') { d.cidade = input.replace(/\s{2,}/g, ' ').replace(/\s*\/\s*/g, '/').trim(); Store.saveSession(s); await startDelivery(channel, clientId, s); return s; }
  if (s.etapa === 'observacao_pedido_menu') {
    if (norm(input) === 'obs_nao') { d.observacaoPedido = null; Store.saveSession(s); return finish(channel, clientId, s, 'letreiro_coleta_completa'); }
    if (norm(input) === 'obs_sim') { s.etapa = 'observacao_pedido_coleta'; Store.saveSession(s); await channel.sendText(clientId, messages.askObservationWrite); return s; }
    await sendMenu(channel, clientId, 'observacao'); return s;
  }
  if (s.etapa === 'observacao_pedido_coleta') {
    d.observacaoPedido = sanitizeObservation(input); Store.saveSession(s); return finish(channel, clientId, s, 'letreiro_coleta_completa');
  }

  await channel.sendText(clientId, messages.fallback);
  return s;
}

module.exports = { processCustomerMessage };
