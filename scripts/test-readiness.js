'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const originalCwd = process.cwd();
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'personalize-readiness-'));
process.chdir(tempDir);

process.env.MOCK_MODE = 'true';
process.env.MIN_REPLY_DELAY_MS = '0';
process.env.MAX_REPLY_DELAY_MS = '0';
process.env.FLOW_SESSION_TTL_HOURS = '1';
process.env.COMPLETED_SESSION_TTL_HOURS = '1';
process.env.UNREAD_BOOTSTRAP_MAX_AGE_HOURS = '24';
process.env.MAINTENANCE_INTERVAL_MS = '60000';
process.env.RUNTIME_CACHE_MAX_ENTRIES = '500';
process.env.MAX_CONCURRENT_CHATS = '2';
delete process.env.ENABLE_TEST_COMMANDS;
delete process.env.ENABLE_UNREAD_BOOTSTRAP;
delete process.env.LABEL_MAINTENANCE_AUTO_REMOVE_DUPLICATES;
process.env.SELLER_LABEL_RULES = 'adriano=green;aninha=blue;carlos=yellow';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function testQueueSerialization() {
  const { ChatTaskQueue } = require('../src/core/chatTaskQueue');
  const queue = new ChatTaskQueue({ maxUnits: 2, maxConcurrentChats: 2, maxQueueSize: 5, taskTimeoutMs: 2000 });
  const events = [];

  const first = queue.enqueue('chat-1', async () => {
    events.push('primeiro-inicio');
    await sleep(30);
    events.push('primeiro-fim');
  });

  const second = queue.enqueue('chat-1', async () => {
    events.push('segundo-inicio');
  });

  await Promise.all([first, second]);
  assert.deepEqual(events, ['primeiro-inicio', 'primeiro-fim', 'segundo-inicio']);
}

async function testQueueConcurrencyLimit() {
  const { ChatTaskQueue } = require('../src/core/chatTaskQueue');
  const queue = new ChatTaskQueue({ maxUnits: 4, maxQueueSize: 10, taskTimeoutMs: 1000 });
  let active = 0;
  let peak = 0;

  const tasks = ['a', 'b', 'c', 'd'].map((chatId) => queue.enqueue(chatId, async () => {
    active += 1;
    peak = Math.max(peak, active);
    await sleep(35);
    active -= 1;
  }));

  await Promise.all(tasks);
  assert.equal(queue.stats().maxConcurrentChats, 2);
  assert.equal(peak, 2);
}

async function testTimeoutKeepsChatLocked() {
  const { ChatTaskQueue } = require('../src/core/chatTaskQueue');
  const queue = new ChatTaskQueue({ maxUnits: 2, maxConcurrentChats: 2, maxQueueSize: 5, taskTimeoutMs: 20 });
  const events = [];

  const first = queue.enqueue('chat-timeout', async () => {
    events.push('lenta-inicio');
    await sleep(60);
    events.push('lenta-fim');
  });

  const second = queue.enqueue('chat-timeout', async () => {
    events.push('seguinte-inicio');
  });

  const [firstResult, secondResult] = await Promise.allSettled([first, second]);
  assert.equal(firstResult.status, 'rejected');
  assert.equal(firstResult.reason?.code, 'QUEUE_TIMEOUT');
  assert.equal(secondResult.status, 'fulfilled');
  assert.deepEqual(events, ['lenta-inicio', 'lenta-fim', 'seguinte-inicio']);
}

async function run() {
  const { env } = require('../src/config/env');
  const { messages } = require('../src/core/messages');
  const MenuCatalog = require('../src/core/menuCatalog');
  const Store = require('../src/services/leadStore');
  const CustomerFlow = require('../src/flow/customerFlow');

  assert.equal(env.enableTestCommands, false);
  assert.equal(env.enableUnreadBootstrap, false);
  assert.equal(env.labelMaintenanceAutoRemoveDuplicates, false);
  assert.equal(env.maxConcurrentChats, 2);

  assert.deepEqual(env.sellerLabelRules, {
    adriano: '#8fd0a8',
    ana: '#00a4f2',
    emy: '#7fe51f',
    'c. eduardo': '#feb100',
  });
  assert.equal(Object.hasOwn(env.sellerLabelRules, 'aninha'), false);
  assert.equal(Object.hasOwn(env.sellerLabelRules, 'carlos'), false);

  const expectedMessages = {
    askService: '🔸\nQual dos nossos serviços deseja?',
    plotagem: 'Perfeito! Vou coletar algumas informações rápidas para registrar sua solicitação completa.',
    otherService: 'Perfeito! Vou coletar algumas informações rápidas para registrar sua solicitação completa.',
    askPlotagemDescricao: 'Me conta rapidinho: qual tipo de plotagem você precisa?\n\nExemplos: vitrine, parede, veículo, placa, adesivo, envelopamento etc. Você também pode enviar uma imagem de referência.',
    askPlotagemMedida: 'Você já tem a medida aproximada?\n\nPode mandar em cm ou metro. Exemplo: 120x80 cm, 2x1m, ou “ainda não tenho medida”.',
    askPlotagemLocal: 'Onde será aplicada a plotagem?\n\nExemplos: vidro, parede, ACM, carro, porta, fachada, balcão etc.',
    askPlotagemPrazo: 'Tem algum prazo ou data que precisa ficar pronto?',
    askOtherDescricao: 'Me conta qual serviço ou produto você precisa. Você também pode enviar uma imagem ou arquivo de referência.',
    askOtherReferencia: 'Você tem alguma medida, foto, referência ou detalhe importante? Pode enviar por texto ou como anexo.',
    askOtherPrazo: 'Tem algum prazo ou urgência para esse pedido?',
    completedContactNote: 'Certo! Seu pedido foi registrado e encaminhado para nossa equipe. Em breve, um vendedor continuará o atendimento por aqui.',
    supportAsk: 'Certo, me explique sua demanda para que eu encaminhe ao nosso suporte.',
    supportForwarded: 'Certo, encaminhei sua mensagem para nossa equipe que em breve assumirá o atendimento. Aguarde por aqui. 🙂',
    supportNeedDetails: 'Pode me explicar o que aconteceu ou qual ajuda você precisa? Você também pode enviar imagem ou arquivo.',
    letteringBudgetIntro: 'Para orçarmos seu letreiro, preciso de algumas informações. Vamos começar pelo tipo de acrílico:',
    askAcrylicType: 'Selecione o tipo de acrílico do seu letreiro:',
    askColorCount: 'Quantas cores terá seu letreiro?',
    askPantone: '🎨 *Cor Personalizada*\n\nMe informe a *cor Pantone* (código da sua cor).\n\nPode também enviar sua paleta de cores ou o arquivo da sua *logo/identidade visual* para referência.',
    askMeasure: '📏 *Me diga, qual será a largura e altura do seu letreiro?*\n(em centímetros)\n\nExemplos:\n• 80x30\n• 120x25\n• só 100 de largura, se não souber a altura\n\n⚠️ Se não souber a altura exata, pode informar só a largura que usaremos uma altura proporcional à arte.',
    askMeasureDescription: 'Sem problemas! Me descreva o tamanho que você imagina.\nEx.: tamanho de uma folha A4, para uma porta, ou proporcional a uma parede.',
    invalidMeasure: 'Não consegui identificar a medida. Você pode enviar assim: *100x20* (em cm), informar apenas a largura/altura, ou descrever um tamanho (ex.: tamanho de uma folha A4).',
    askArtQuestion: '🖼️ Agora preciso da arte do seu letreiro.',
    askArtExplanation: 'Você pode enviar um arquivo em PDF/AI/EPS/SVG, uma imagem de referência ou apenas descrever sua ideia.',
    askArtFree: '📂 Pode enviar tudo em mensagens separadas. Vou juntar as informações antes de continuar.',
    askArtFile: 'Perfeito! Envie o arquivo da arte por aqui. Você também pode mandar observações em mensagens separadas.',
    askArtImage: 'Perfeito! Envie a imagem de referência por aqui e, se precisar, escreva os detalhes em outras mensagens.',
    askArtDescription: 'Perfeito! Descreva como imagina o letreiro. Pode mandar em várias mensagens que vou juntar tudo.',
    askCity: '📍\nPara finalizarmos, me diga sua *cidade e estado*.\nEx.: Belo Horizonte/MG',
    askAddress: 'Qual seu endereço completo?\n(Rua/Av + número, Bairro, CEP e Complemento, se houver)',
    pickupAddress: 'Combinado! Você poderá retirar na empresa.\n\n📍 Nós estamos localizados na Rua Selênio 226, Bairro Prado.',
    installationNote: 'Para instalação, a equipe precisa analisar o endereço e os detalhes informados antes da confirmação final.',
    askObservation: '📝\nGostaria de anexar alguma informação sobre o letreiro? Pode ser quantidade, detalhe de logo, observação de instalação, acabamento ou qualquer ponto importante.',
    askObservationText: 'Perfeito! Pode me contar o que gostaria de acrescentar?',
    askObservationWrite: 'Perfeito! Pode me contar o que gostaria de acrescentar?',
    askGeneralObservation: '📝\nGostaria de acrescentar alguma observação ou detalhe importante sobre o pedido?',
    askGeneralObservationText: 'Perfeito! Pode me contar o que gostaria de acrescentar?',
    fallback: 'Não consegui entender direitinho. Vou reenviar a etapa atual para você escolher novamente.',
  };

  for (const [key, expected] of Object.entries(expectedMessages)) {
    assert.equal(messages[key], expected, `Texto alterado sem atualizar o teste: ${key}`);
  }

  assert.equal(messages.welcome('Emilly'), 'Olá, Emilly! 👋\nBem-vindo(a) ao Canal de Atendimento da Personalize!');
  assert.equal(messages.welcome('Emilly', { isReturning: true }), 'Olá, Emilly! 👋\nQue bom te ver novamente no Canal de Atendimento da Personalize!');

  assert.deepEqual(
    MenuCatalog.menus.servicos.rows.map(({ id, title, description }) => ({ id, title, description })),
    [
      { id: 'serv_letreiro', title: 'Letreiro de acrílico', description: 'Solicitar orçamento do meu letreiro' },
      { id: 'serv_plotagem', title: 'Plotagem', description: 'Vitrines, paredes, veículos e adesivos' },
      { id: 'serv_outros', title: 'Outros', description: 'Placas, fachadas e outros serviços' },
      { id: 'serv_suporte', title: 'Suporte', description: 'Dúvidas ou atendimento com nossa equipe' },
    ],
  );
  assert.deepEqual(MenuCatalog.menus.quantidadeCores.rows.map((row) => row.id), [
    'corq_1', 'corq_2', 'corq_3', 'corq_4', 'corq_5', 'corq_voltar',
  ]);
  assert.deepEqual(MenuCatalog.buildSolidColorMenu(1, 1).rows.map((row) => row.title), [
    'Preto', 'Branco', 'Cinza', 'Azul', 'Verde', 'Vermelho', 'Amarelo', 'Voltar',
  ]);
  assert.deepEqual(MenuCatalog.buildMirrorColorMenu(1, 1).rows.map((row) => row.title), [
    'Dourado', 'Prata', 'Rosê', 'Vermelho espelhado', 'Verde espelhado',
    'Azul espelhado', 'Roxo espelhado', 'Voltar',
  ]);

  const observationClient = '5531999999911';
  const observationSession = Store.getSession(observationClient);
  observationSession.etapa = 'observacao_pedido_menu';
  observationSession.dados = { flow: 'letreiro' };
  Store.saveSession(observationSession);
  const sent = [];
  await CustomerFlow.processCustomerMessage({
    clientId: observationClient,
    text: 'obs_sim',
    channel: { sendText: async (_id, text) => sent.push(text) },
    messages: [],
  });
  assert.equal(Store.getSession(observationClient).etapa, 'observacao_pedido_coleta');
  assert.deepEqual(sent, [expectedMessages.askObservationWrite]);

  const expiredClient = '5531999999922';
  const expiredSession = Store.getSession(expiredClient);
  expiredSession.etapa = 'cidade';
  expiredSession.expiresAt = new Date(Date.now() - 1000).toISOString();
  const renewed = Store.getSession(expiredClient);
  assert.equal(renewed.etapa, 'inicio');
  assert.equal(renewed.completed, false);

  const readiness = require('../src/core/vpsReadinessPreload');
  assert.equal(readiness.findExactSellerLabel([{ name: 'Adriano' }]).seller, 'adriano');
  assert.equal(readiness.findExactSellerLabel([{ name: 'Ana' }]).seller, 'ana');
  assert.equal(readiness.findExactSellerLabel([{ name: 'Emy' }]).seller, 'emy');
  assert.equal(readiness.findExactSellerLabel([{ name: 'C. Eduardo' }]).seller, 'c. eduardo');
  assert.equal(readiness.findExactSellerLabel([{ name: 'Adriano Silva' }]), null);
  assert.equal(readiness.findExactSellerLabel([{ name: 'Acompanhar' }]), null);
  assert.equal(
    readiness.findExactSellerLabel([
      { name: 'fornecedor', hexColor: '#feb100' },
      { name: 'C. Eduardo', hexColor: '#feb100' },
    ]).seller,
    'c. eduardo',
    'cor igual em etiqueta manual não pode impedir a detecção do vendedor pelo nome exato',
  );

  const now = Date.now();
  assert.equal(readiness.isUnreadWithinAge({ raw: { timestamp: Math.floor((now - 3600000) / 1000) } }, { now, maxAgeHours: 24 }), true);
  assert.equal(readiness.isUnreadWithinAge({ raw: { timestamp: Math.floor((now - (25 * 3600000)) / 1000) } }, { now, maxAgeHours: 24 }), false);

  await testQueueSerialization();
  await testQueueConcurrencyLimit();
  await testTimeoutKeepsChatLocked();

  console.log('✅ Prontidão verificada: textos, fluxo, TTL, fila, timeout, vendedores, cache e não lidas.');
}

run()
  .catch((error) => {
    console.error('❌ Teste de prontidão falhou:', error?.stack || error?.message || error);
    process.exitCode = 1;
  })
  .finally(() => {
    process.chdir(originalCwd);
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
  });
