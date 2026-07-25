'use strict';

const { BufferManager, mergeMessages } = require('./core/bufferManager');
const { ChatTaskQueue } = require('./core/chatTaskQueue');
const { processCustomerMessage } = require('./flow/customerFlow');
const {
  createWppChannel,
  createMockChannel,
  collectUnreadMessages,
} = require('./services/wppconnectClient');
const { installMessageExperience } = require('./core/messageExperience');
const { installDecisionChannelInstrumentation } = require('./core/decisionChannelInstrumentation');
const {
  decision,
  decisionError,
  messageContext,
  metric,
  textPreview,
  withDecisionContext,
} = require('./core/decisionLogger');
const { isAllowedClient } = require('./core/allowedClient');
const { extractName, normalizeText, titleCase } = require('./core/parsers');
const {
  initializeServiceLabels,
  replaceServiceLabel,
} = require('./core/serviceLabels');
const { getAutomationBlock, registerManualTakeover } = require('./core/sellerHandoff');
const {
  bufferDelayMultiplier,
  evaluate: evaluateRuntimePressure,
  getRuntimeProtectionState,
  shouldSkipNonCriticalRepairs,
  startRuntimeProtection,
} = require('./core/runtimeProtection');
const BotActivity = require('./services/botActivityStore');
const Store = require('./services/leadStore');
const Identity = require('./services/contactIdentity');
const { env } = require('./config/env');

const BUILD_ID = 'real-whatsapp-business-lists-create-and-recover-2026-07-10-07';
const ACTIVE_SERVICE_FLOWS = new Set(['letreiro', 'plotagem', 'outros']);
const MULTI_MESSAGE_STAGES = new Set([
  'plotagem_descricao',
  'plotagem_medida',
  'plotagem_local',
  'outros_descricao',
  'outros_referencia',
]);
const IMMEDIATE_TEST_COMMANDS = new Set(['/reset', '/reiniciar', '/resetarsys']);

function messageKey(message) {
  const rawId = message?.id?._serialized || message?.id || message?.messageId || message?.key?.id;
  if (rawId) return String(rawId);
  return `${message?.from || message?.chatId || 'unknown'}:${message?.body || message?.text || message?.caption || ''}:${message?.timestamp || ''}`;
}

function sanitizePersonName(value) {
  let name = String(value || '')
    .split(/[\n\r|•]/)[0]
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/\+?\d[\d\s().-]{7,}/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  name = name
    .replace(/^[^A-Za-zÀ-ÿ]+/u, '')
    .replace(/[^A-Za-zÀ-ÿ'’ -]+$/u, '')
    .trim();

  if (!name || name.length < 2 || name.length > 60 || !/[A-Za-zÀ-ÿ]/u.test(name)) return null;
  if (/\d{3,}/.test(name)) return null;
  const generic = normalizeText(name);
  if (['voce', 'você', 'usuario', 'usuário', 'whatsapp', 'desconhecido', 'unknown'].includes(generic)) return null;
  return titleCase(name);
}

function extractProfileName(raw) {
  const candidates = [
    raw?.notifyName,
    raw?.pushname,
    raw?.sender?.pushname,
    raw?.sender?.name,
    raw?.sender?.shortName,
    raw?.sender?.formattedName,
    raw?.contact?.pushname,
    raw?.contact?.name,
    raw?.contact?.shortName,
    raw?.contact?.formattedName,
    raw?.chat?.contact?.pushname,
    raw?.chat?.contact?.name,
    raw?.chat?.contact?.shortName,
    raw?.chat?.contact?.formattedName,
  ];
  for (const candidate of candidates) {
    const name = sanitizePersonName(candidate);
    if (name) return name;
  }
  return null;
}

function extractInteractiveId(raw = {}) {
  const candidates = [
    raw?.selectedRowId,
    raw?.selectedButtonId,
    raw?.listResponse?.singleSelectReply?.selectedRowId,
    raw?.listResponseMessage?.singleSelectReply?.selectedRowId,
    raw?.buttonsResponseMessage?.selectedButtonId,
    raw?.templateButtonReplyMessage?.selectedId,
    raw?.interactive?.list_reply?.id,
    raw?.interactive?.button_reply?.id,
    raw?.nativeFlowResponseMessage?.paramsJson,
  ];

  for (const candidate of candidates) {
    if (!candidate) continue;
    if (typeof candidate === 'string') {
      const text = candidate.trim();
      if (!text) continue;
      if (text.startsWith('{')) {
        try {
          const parsed = JSON.parse(text);
          const id = parsed?.id || parsed?.row_id || parsed?.selectedRowId;
          if (id) return String(id).trim();
        } catch (_) {}
      }
      return text;
    }
  }
  return '';
}

function mediaMarker(raw = {}) {
  const type = String(raw?.type || raw?.mimetype || raw?.mediaType || '').toLowerCase();
  const fileName = raw?.filename || raw?.fileName || raw?.document?.filename || '';
  if (/image/.test(type)) return '[imagem enviada]';
  if (/document|pdf|application/.test(type) || fileName) return `[arquivo enviado${fileName ? `: ${fileName}` : ''}]`;
  if (/video/.test(type)) return '[vídeo enviado]';
  return '';
}

function firstLine(value) {
  return String(value || '').split(/\r?\n/).map((line) => line.trim()).find(Boolean) || '';
}

function isImmediateTestCommand(text) {
  const command = firstLine(text).toLowerCase();
  return IMMEDIATE_TEST_COMMANDS.has(command);
}

async function runImmediateTestCommand(channel, clientId, text) {
  const command = firstLine(text).toLowerCase();
  if (!env.enableTestCommands || !IMMEDIATE_TEST_COMMANDS.has(command)) return false;

  if (command === '/resetarsys') {
    const result = Store.resetSystem();
    await channel.sendText(
      clientId,
      `Sistema resetado para teste.\n\nSessões apagadas: ${result.previousSessionCount}\nPerfis apagados: ${result.previousProfileCount}\nLeads apagados: ${result.previousLeadCount}\n\nMe envie uma nova mensagem para começar como primeiro contato.`,
      { noDelay: true, noTyping: true }
    );
    Store.resetSession(clientId);
    return true;
  }

  if (command === '/reset' || command === '/reiniciar') {
    Store.resetSession(clientId);
    await channel.sendText(
      clientId,
      'Atendimento reiniciado para teste. Envie uma nova mensagem para começar.',
      { noDelay: true, noTyping: true }
    );
    return true;
  }

  return false;
}

function prepareBufferedInput(clientId, text, bufferedMessages) {
  const session = Store.getSession(clientId);
  if (!session) return text;

  const explicitName = sanitizePersonName(extractName(text));
  const profileName = bufferedMessages
    .map((item) => sanitizePersonName(item?.profileName) || extractProfileName(item?.raw))
    .find(Boolean);

  const chosenName = explicitName || (!session.dados?.nome ? profileName : null);
  if (chosenName) {
    session.dados = session.dados || {};
    session.dados.nome = chosenName;
    session.dados.nomeOrigem = explicitName ? 'mensagem' : 'perfil_whatsapp';
    Store.saveSession(session);
    console.log(`[CLIENTE ${clientId}] nome identificado (${session.dados.nomeOrigem}): ${chosenName}`);
  }

  return text;
}

function resolveBufferDelay(clientId, raw, interactiveId) {
  if (interactiveId) return env.interactiveBufferMs;
  const session = Store.getSession(clientId);
  const stage = String(session?.etapa || '').trim();
  const multiplier = bufferDelayMultiplier();

  if (stage === 'tamanho') return Math.round(env.measureBufferMs * multiplier);
  if (stage === 'arte_coleta') return Math.round(env.artBufferMs * multiplier);
  if (stage === 'endereco') return Math.round(env.addressBufferMs * multiplier);
  if (stage === 'pantone') return Math.round(env.pantoneBufferMs * multiplier);
  if (stage === 'observacao_pedido_coleta') return Math.round(env.observationBufferMs * multiplier);
  if (stage === 'cidade') return Math.round(env.cityBufferMs * multiplier);
  if (MULTI_MESSAGE_STAGES.has(stage)) return Math.round(env.multiMessageBufferMs * multiplier);
  return Math.round(env.bufferMs * multiplier);
}

function getActiveServiceFlow(session) {
  if (!session || session.completed || session.dados?.botDone) return null;
  const flow = String(session.dados?.flow || '').trim().toLowerCase();
  if (!ACTIVE_SERVICE_FLOWS.has(flow)) return null;

  const stage = String(session.etapa || '').trim();
  if (!stage || ['inicio', 'escolher_servico', 'concluido'].includes(stage)) return null;
  return flow;
}

function serviceRepairKey(session, flow, fallbackClientId = '') {
  const contactId = session?.chatId || session?.clientId || session?.id || fallbackClientId;
  return `${Store.normalizeClientId(contactId)}:${flow}`;
}

function formatQueueStats(stats = {}) {
  return `units=${Number(stats.runningUnits || 0)}/${Number(stats.limit || 0)} queued=${Number(stats.queued || 0)}`;
}

function estimateTaskUnits({ clientId, preparedText, bufferedMessages }) {
  const stage = String(Store.getSession(clientId)?.etapa || '').trim();
  const normalizedText = normalizeText(preparedText);
  const hasMedia = Array.isArray(bufferedMessages)
    && bufferedMessages.some((item) => {
      const type = String(item?.raw?.type || item?.raw?.mimetype || item?.raw?.mediaType || '').toLowerCase();
      return /image|document|pdf|application|video/.test(type);
    });

  if (!normalizedText) return 1;
  if (isImmediateTestCommand(preparedText)) return 0;
  if (stage === 'inicio') return 2;
  if (hasMedia) return 2;
  if (normalizedText.length > 500) return 2;
  if (MULTI_MESSAGE_STAGES.has(stage)) return 2;
  return 1;
}

function activeSessionUpdatedAt(session) {
  const candidates = [
    session?.lastInteractionAt,
    session?.updatedAt,
    session?.createdAt,
  ];
  for (const candidate of candidates) {
    const value = new Date(candidate).getTime();
    if (Number.isFinite(value) && value > 0) return value;
  }
  return 0;
}

function activeRecoverySessions() {
  return Store.listSessions()
    .filter((session) => !session?.completed)
    .filter((session) => {
      const stage = String(session?.etapa || '').trim();
      return Boolean(stage && stage !== 'inicio' && stage !== 'concluido');
    })
    .sort((a, b) => activeSessionUpdatedAt(b) - activeSessionUpdatedAt(a));
}

function historyMessageId(message = {}) {
  return String(
    message?.id?._serialized
    || message?.id
    || message?.messageId
    || message?.key?.id
    || ''
  ).trim() || null;
}

function historyTimestampMs(message = {}) {
  const candidates = [
    message?.timestamp,
    message?.t,
    message?.messageTimestamp,
    message?.id?.timestamp,
  ];
  for (const candidate of candidates) {
    const value = Number(candidate);
    if (!Number.isFinite(value) || value <= 0) continue;
    return value < 1000000000000 ? value * 1000 : value;
  }
  return null;
}

function historyVisibleText(message = {}) {
  return String(message?.body || message?.caption || message?.text || '').trim() || mediaMarker(message);
}

function isVisibleIncomingHistory(message = {}) {
  if (message?.fromMe) return false;
  const chatId = String(message?.from || message?.chatId || message?.id?.remote || message?.key?.remoteJid || '').trim();
  if (!chatId || /@g\.us$/i.test(chatId)) return false;
  return Boolean(historyVisibleText(message));
}

function isVisibleOutgoingHistory(message = {}) {
  return Boolean(message?.fromMe && historyVisibleText(message));
}

function recoveryCandidateChatIds(clientId) {
  const direct = Identity.normalizeChatId(clientId);
  let known = [];
  try { known = Identity.getLabelCandidateIds(clientId); } catch (_) {}
  return [...new Set([direct, ...known].filter(Boolean))];
}

async function readRecoveryConversationHistory(client, clientId) {
  const candidates = recoveryCandidateChatIds(clientId);
  const attempts = [];

  for (const chatId of candidates) {
    if (typeof client?.getAllMessagesInChat === 'function') {
      try {
        const raw = await client.getAllMessagesInChat(chatId, true, false);
        const messages = Array.isArray(raw) ? raw : Object.values(raw || {});
        attempts.push({ chatId, available: true, messages });
        if (messages.length) return { available: true, chatId, messages };
      } catch (_) {}
    }
  }

  if (client?.page?.evaluate) {
    for (const chatId of candidates) {
      try {
        const messages = await client.page.evaluate(async ({ chatId, limit }) => {
          const WPP = window.WPP || null;
          if (typeof WPP?.chat?.getMessages !== 'function') return null;
          const raw = await WPP.chat.getMessages(chatId, { count: limit, direction: 'before' });
          return Array.isArray(raw) ? raw : Object.values(raw || {});
        }, { chatId, limit: env.unreadRecoveryHistoryLimit || 120 });
        if (Array.isArray(messages)) {
          attempts.push({ chatId, available: true, messages });
          if (messages.length) return { available: true, chatId, messages };
        }
      } catch (_) {}
    }
  }

  return {
    available: attempts.some((item) => item.available),
    chatId: candidates[0] || null,
    messages: [],
  };
}

function findPendingCustomerReply(session, messages = []) {
  const sorted = [...(messages || [])].sort((a, b) => {
    const at = historyTimestampMs(a);
    const bt = historyTimestampMs(b);
    if (at === null || bt === null) return 0;
    return at - bt;
  });

  if (!sorted.length) return null;

  const checkpoint = BotActivity.getLastBotOutbound(session?.chatId || session?.clientId || session?.id);
  const sessionUpdatedAt = activeSessionUpdatedAt(session);
  const checkpointAt = checkpoint?.at ? new Date(checkpoint.at).getTime() : 0;
  const baselineAt = Math.max(sessionUpdatedAt, Number.isFinite(checkpointAt) ? checkpointAt : 0);
  const maxAgeMs = Math.max(1, Number(env.unreadBootstrapMaxAgeHours || 24)) * 60 * 60 * 1000;
  const oldestAllowedAt = Date.now() - maxAgeMs;

  let checkpointIndex = -1;
  const checkpointId = String(checkpoint?.messageId || '').trim();
  if (checkpointId) {
    checkpointIndex = sorted.findIndex((message) => historyMessageId(message) === checkpointId);
  }

  for (let index = sorted.length - 1; index >= 0; index -= 1) {
    const message = sorted[index];
    if (!isVisibleIncomingHistory(message)) continue;

    const timestamp = historyTimestampMs(message);
    if (timestamp !== null && timestamp < oldestAllowedAt) continue;

    const afterCheckpoint = checkpointIndex >= 0
      ? index > checkpointIndex
      : (timestamp !== null && timestamp > (baselineAt + 1500));

    if (!afterCheckpoint) continue;

    const outgoingAfter = sorted.slice(index + 1).some(isVisibleOutgoingHistory);
    if (outgoingAfter) continue;

    return {
      message,
      text: historyVisibleText(message),
      timestamp,
      reason: checkpointIndex >= 0 ? 'apos_checkpoint_sem_resposta' : 'apos_estado_salvo_sem_resposta',
    };
  }

  return null;
}

async function recoverPendingActiveSessions(channel, onMessage) {
  if (!channel?.client || typeof onMessage !== 'function') return { scanned: 0, recovered: 0 };

  const sessions = activeRecoverySessions().slice(0, Math.max(1, Number(env.unreadBootstrapMaxChats || 30)));
  let recovered = 0;

  for (const session of sessions) {
    const clientId = session?.chatId || session?.clientId || session?.id;
    if (!clientId) continue;

    const guard = await getAutomationBlock(channel, clientId);
    if (guard?.blocked) {
      console.log(`[RETOMADA] sessão ignorada por handoff | cliente=${clientId} | motivo=${guard.reason}`);
      continue;
    }

    const history = await readRecoveryConversationHistory(channel.client, clientId);
    if (!history.available) {
      console.log(`[RETOMADA] histórico indisponível | cliente=${clientId}`);
      continue;
    }

    const pending = findPendingCustomerReply(session, history.messages);
    if (!pending?.message) continue;

    recovered += 1;
    console.log(
      `[RETOMADA] resposta pendente recuperada | cliente=${clientId} | etapa=${session.etapa} `
      + `| motivo=${pending.reason} | texto=${String(pending.text || '[sem texto]').slice(0, 120)}`,
    );
    await onMessage({
      from: clientId,
      text: pending.text,
      raw: pending.message,
      source: 'history-recovery',
    });
  }

  console.log(`[RETOMADA] varredura concluída | sessões=${sessions.length} | recuperadas=${recovered}`);
  return { scanned: sessions.length, recovered };
}

async function repairSessionServiceLabel(channel, clientId, repairedKeys, source = 'runtime') {
  if (!channel?.client) return false;
  if (shouldSkipNonCriticalRepairs()) {
    console.log(`[AUTOPROTEÇÃO] reparo de etiqueta adiado | cliente=${clientId} | origem=${source}`);
    return false;
  }

  const session = Store.getSession(clientId);
  const flow = getActiveServiceFlow(session);
  if (!flow) return false;

  const contactId = session.chatId || session.clientId || session.id || clientId;
  const key = serviceRepairKey(session, flow, contactId);
  if (repairedKeys.has(key)) return true;

  try {
    const result = await replaceServiceLabel(channel, contactId, flow);
    const applied = result === true || result?.applied === true;
    if (applied) {
      repairedKeys.add(key);
      console.log(`[LISTAS] atendimento ativo recuperado (${source}): ${contactId} -> ${flow}`);
      return true;
    }
  } catch (err) {
    console.warn(`[LISTAS] falha ao recuperar atendimento ativo ${contactId} (${flow}):`, err?.message || err);
  }

  return false;
}

async function reconcileActiveServiceLists(channel, repairedKeys) {
  if (!channel?.client) return { found: 0, repaired: 0 };
  if (shouldSkipNonCriticalRepairs()) {
    console.log('[AUTOPROTEÇÃO] recuperação pós-reinício de etiquetas adiada por pressão interna.');
    return { found: 0, repaired: 0, skipped: true };
  }

  const sessions = Store.listSessions();
  let found = 0;
  let repaired = 0;

  for (const session of sessions) {
    const flow = getActiveServiceFlow(session);
    if (!flow) continue;

    found += 1;
    const contactId = session.chatId || session.clientId || session.id;
    if (await repairSessionServiceLabel(channel, contactId, repairedKeys, 'reinício')) {
      repaired += 1;
    }
  }

  console.log(`[LISTAS] recuperação pós-reinício concluída: ativos=${found} recuperados=${repaired}`);
  return { found, repaired };
}

function blockPdfSending(channel) {
  if (!channel) return;
  if (typeof channel.sendDocument === 'function') {
    channel.sendDocument = async () => {
      console.warn('[BLOQUEIO PDF] tentativa de envio de documento bloqueada. O mostruário usa somente link.');
      return false;
    };
  }

  const client = channel.client;
  if (typeof client?.sendFile !== 'function' || client.__personalizePdfGuardInstalled) return;
  const originalSendFile = client.sendFile.bind(client);
  client.sendFile = async (...args) => {
    const serialized = args.map((value) => {
      if (typeof value === 'string') return value;
      try { return JSON.stringify(value); } catch (_) { return String(value || ''); }
    }).join(' ').toLowerCase();
    if (serialized.includes('.pdf') && serialized.includes('mostruario')) {
      console.warn('[BLOQUEIO PDF] envio do PDF de mostruário bloqueado.');
      return false;
    }
    return originalSendFile(...args);
  };
  client.__personalizePdfGuardInstalled = true;
}

async function main() {
  const packageJson = require('../package.json');
  decision('SISTEMA', 'inicialização', {
    versão: packageJson.version,
    base_commit: 'fe6ca12',
    build: BUILD_ID,
    storage: env.storageDriver || process.env.STORAGE_DRIVER || 'file',
    sessão: env.sessionName,
  });
  console.log('[PersonalizeWppConect] iniciando...');
  console.log(`[PersonalizeWppConect] BUILD: ${BUILD_ID}`);
  console.log(`[PersonalizeWppConect] buffer comum: ${env.bufferMs}ms`);
  console.log(`[PersonalizeWppConect] buffers de coleta: medida=${env.measureBufferMs}ms arte=${env.artBufferMs}ms endereço=${env.addressBufferMs}ms Pantone=${env.pantoneBufferMs}ms observação=${env.observationBufferMs}ms cidade=${env.cityBufferMs}ms`);
  console.log(`[PersonalizeWppConect] buffer listas/botões: ${env.interactiveBufferMs}ms`);
  console.log(`[PersonalizeWppConect] fila global: consumo=${env.queueMaxUnits}u espera=${env.maxQueueSize} timeout=${env.chatProcessTimeoutMs}ms`);
  console.log(`[PersonalizeWppConect] autoproteção: fila>=${env.runtimePressureQueueThreshold} ou rss>=${env.runtimePressureRssMb}MB reduz typing e adia reparos não críticos`);
  console.log('[PersonalizeWppConect] handoff: etiqueta de vendedor e mensagem manual bloqueiam o bot automaticamente');
  console.log('[PersonalizeWppConect] respostas comuns: digitação única + balões sem pausa artificial');
  console.log('[PersonalizeWppConect] boas-vindas: saudação + imagem com link na legenda + lista, com digitação única antes do grupo');
  console.log('[PersonalizeWppConect] listas: cria uma única vez com WPP.lists, reutiliza pelo nome, recupera sessões ativas e nunca remove listas manuais');
  console.log('[PersonalizeWppConect] finalização: dados salvos na nota do contato; sem encaminhamento ao vendedor');

  if (env.allowedClientNumbers?.length || env.allowedChatIds?.length) {
    console.log(`[PersonalizeWppConect] whitelist ativa: números=${env.allowedClientNumbers.join(', ') || '-'} chatIds=${env.allowedChatIds.join(', ') || '-'}`);
  }

  let channel = null;
  const processedMessageIds = new Set();
  const repairedServiceLabels = new Set();
  const taskQueue = new ChatTaskQueue({
    maxUnits: env.queueMaxUnits,
    maxQueueSize: env.maxQueueSize,
    taskTimeoutMs: env.chatProcessTimeoutMs,
  });
  startRuntimeProtection(taskQueue);

  const buffer = new BufferManager({
    delayMs: env.bufferMs,
    onFlush: async (clientId, bufferedMessages) => {
      const lastBuffered = bufferedMessages[bufferedMessages.length - 1] || {};
      const currentStage = String(Store.getSession(clientId)?.etapa || '').trim() || '-';
      const trace = {
        ...(lastBuffered.trace || messageContext({
          raw: lastBuffered.raw,
          chatId: clientId,
          source: lastBuffered.source || 'buffer',
          text: lastBuffered.text,
          stage: currentStage,
        })),
        chat: clientId,
        etapa: currentStage,
        metrics: { outbound: 0, labels: 0, notes: 0 },
      };

      return withDecisionContext(trace, async () => {
        decision('BUFFER', 'liberado', {
          quantidade: bufferedMessages.length,
          espera: `${Number(lastBuffered.delayMs || 0)}ms`,
        });

        const guardBeforeQueue = await getAutomationBlock(channel, clientId);
        if (guardBeforeQueue.blocked) {
          decision('HANDOFF', 'bloqueado_antes_da_fila', {
            status: 'bloqueado',
            motivo: guardBeforeQueue.reason,
            vendedor: guardBeforeQueue.seller || '-',
            etiqueta: guardBeforeQueue.labelName || '-',
          });
          decision('BUFFER', 'descartado', {
            motivo: 'human_handoff',
            quantidade: bufferedMessages.length,
          });
          buffer.clear(clientId);
          return;
        }
        decision('HANDOFF', 'verificado_antes_da_fila', { status: 'livre' });

        const text = mergeMessages(bufferedMessages);
        if (!text) {
          decision('BUFFER', 'ignorado', { motivo: 'conteúdo_vazio' });
          return;
        }
        const preparedText = prepareBufferedInput(clientId, text, bufferedMessages);
        console.log(`
[CLIENTE ${clientId}] ${preparedText}
`);

        const units = estimateTaskUnits({ clientId, preparedText, bufferedMessages });
        const queuedAt = Date.now();
        evaluateRuntimePressure(taskQueue);
        const statsBefore = taskQueue.stats();
        decision('FILA', 'agendada', {
          unidades: units,
          posição: statsBefore.queued + 1,
          execução: `${statsBefore.runningUnits}/${statsBefore.limit}`,
        });

        try {
          await taskQueue.enqueue(clientId, async () => {
            evaluateRuntimePressure(taskQueue);
            const guardBeforeRun = await getAutomationBlock(channel, clientId);
            if (guardBeforeRun.blocked) {
              decision('HANDOFF', 'bloqueado_antes_do_processamento', {
                status: 'bloqueado',
                motivo: guardBeforeRun.reason,
                vendedor: guardBeforeRun.seller || '-',
                etiqueta: guardBeforeRun.labelName || '-',
              });
              decision('FLUXO', 'não_processado', { motivo: 'human_handoff' });
              return;
            }
            decision('HANDOFF', 'verificado_antes_do_processamento', { status: 'livre' });

            const waitMs = Date.now() - queuedAt;
            const beforeSession = Store.getSession(clientId);
            const beforeStage = String(beforeSession?.etapa || '').trim() || '-';
            decision('FILA', 'iniciada', {
              etapa: beforeStage,
              unidades: units,
              espera: `${waitMs}ms`,
            });

            const action = async () => {
              const startedAt = Date.now();
              decision('FLUXO', 'iniciado', { etapa: beforeStage, texto: textPreview(preparedText) });
              try {
                const result = await processCustomerMessage({
                  clientId,
                  text: preparedText,
                  channel,
                  messages: bufferedMessages,
                });
                const afterSession = Store.getSession(clientId);
                const afterStage = String(afterSession?.etapa || '').trim() || '-';
                decision('FLUXO', 'concluído', {
                  de: beforeStage,
                  para: afterStage,
                  envios: metric('outbound'),
                  respondeu: metric('outbound') > 0,
                  duração: `${Date.now() - startedAt}ms`,
                  resultado: afterSession?.completed ? 'concluído' : 'ativo',
                });
                return result;
              } catch (error) {
                decisionError('fluxo_falhou', error, {
                  de: beforeStage,
                  envios: metric('outbound'),
                  duração: `${Date.now() - startedAt}ms`,
                });
                throw error;
              }
            };

            if (typeof channel?.runResponseGroup === 'function') {
              await channel.runResponseGroup(clientId, preparedText, action);
              return;
            }

            await action();
          }, { units });

          evaluateRuntimePressure(taskQueue);
          const statsAfter = taskQueue.stats();
          decision('FILA', 'concluída', {
            execução: `${statsAfter.runningUnits}/${statsAfter.limit}`,
            pendentes: statsAfter.queued,
          });
        } catch (err) {
          evaluateRuntimePressure(taskQueue);
          const reason = err?.code || 'QUEUE_ERROR';
          decisionError('fila_falhou', err, { motivo: reason });
          await channel?.markUnread?.(clientId).catch(() => false);
        }
      });
    },
  });

  const onOutgoingMessage = async ({ from, text, raw, source = 'outgoing-event' }) => {
    const effectiveText = String(text || '').trim() || mediaMarker(raw);
    const initialTrace = messageContext({ raw, chatId: from, source, text: effectiveText, stage: '-' });

    return withDecisionContext(initialTrace, async () => {
      const identity = Identity.registerContact({ chatId: from, raw });
      const canonicalChatId = identity?.primaryChatId || from;
      if (!canonicalChatId || /@g\.us$/i.test(canonicalChatId)) return;

      decision('IDENTIDADE', 'resolvida_para_saída', {
        chat: canonicalChatId,
        original: from,
        canônico: canonicalChatId,
      });

      const allowed = isAllowedClient({ from: canonicalChatId, raw });
      if (!allowed.allowed) {
        decision('HANDOFF', 'saída_ignorada', { chat: canonicalChatId, motivo: 'fora_da_whitelist' });
        return;
      }

      const matchedBotMessage = channel?.outboundTracker?.consumeIfBot?.(canonicalChatId, raw);
      if (matchedBotMessage) {
        decision('HANDOFF', 'saída_do_bot_reconhecida', {
          chat: canonicalChatId,
          status: 'livre',
          tipo: matchedBotMessage.type,
        });
        return;
      }

      registerManualTakeover(canonicalChatId, {
        reason: 'manual_outbound_message',
        source: 'manual_outbound_message',
        blockedHours: env.humanBlockHours,
      });
      const discarded = buffer.clear(canonicalChatId);

      decision('HANDOFF', 'mensagem_humana_detectada', {
        chat: canonicalChatId,
        status: 'bloqueado',
        motivo: 'manual_outbound_message',
        origem: source,
        texto: textPreview(effectiveText || '[sem texto]'),
      });
      if (discarded) decision('BUFFER', 'descartado', { chat: canonicalChatId, quantidade: discarded, motivo: 'human_handoff' });
    });
  };

  const onMessage = async ({ from, text, raw, source = 'event' }) => {
    const interactiveId = extractInteractiveId(raw);
    const effectiveText = interactiveId || String(text || '').trim() || mediaMarker(raw);
    if (!effectiveText) return;

    const initialStage = String(Store.getSession(from)?.etapa || '').trim() || '-';
    const trace = messageContext({ raw, chatId: from, source, text: effectiveText, stage: initialStage });

    return withDecisionContext(trace, async () => {
      decision('ENTRADA', 'recebida', {
        chat: from,
        etapa: initialStage,
        origem: source,
        tipo: interactiveId ? 'interativa' : (mediaMarker(raw) ? 'mídia' : 'texto'),
        texto: textPreview(effectiveText),
      });

      const profileName = extractProfileName(raw);
      const identity = Identity.registerContact({ chatId: from, raw });
      const canonicalChatId = identity?.primaryChatId || from;
      const stage = String(Store.getSession(canonicalChatId)?.etapa || initialStage || '').trim() || '-';
      Object.assign(trace, { chat: canonicalChatId, etapa: stage });
      decision('IDENTIDADE', 'resolvida', {
        chat: canonicalChatId,
        etapa: stage,
        original: from,
        canônico: canonicalChatId,
        aliases: Array.isArray(identity?.aliases) ? identity.aliases.length : undefined,
      });

      const allowed = isAllowedClient({ from: canonicalChatId, raw });
      if (!allowed.allowed) {
        decision('ENTRADA', 'ignorada', { chat: canonicalChatId, motivo: 'fora_da_whitelist' });
        return;
      }

      if (await runImmediateTestCommand(channel, canonicalChatId, effectiveText)) {
        decision('ADMIN', 'comando_imediato_executado', {
          chat: canonicalChatId,
          ação: firstLine(effectiveText).toLowerCase(),
          resultado: 'concluído',
        });
        const discarded = buffer.clear(canonicalChatId);
        if (discarded) decision('BUFFER', 'descartado', { quantidade: discarded, motivo: 'admin_command' });
        return;
      }

      const guardBeforeBuffer = await getAutomationBlock(channel, canonicalChatId);
      if (guardBeforeBuffer.blocked) {
        decision('HANDOFF', 'bloqueado_antes_do_buffer', {
          chat: canonicalChatId,
          status: 'bloqueado',
          motivo: guardBeforeBuffer.reason,
          vendedor: guardBeforeBuffer.seller || '-',
          etiqueta: guardBeforeBuffer.labelName || '-',
        });
        const discarded = buffer.clear(canonicalChatId);
        if (discarded) decision('BUFFER', 'descartado', { quantidade: discarded, motivo: 'human_handoff' });
        decision('FLUXO', 'não_processado', { motivo: 'human_handoff' });
        return;
      }
      decision('HANDOFF', 'verificado_antes_do_buffer', { chat: canonicalChatId, status: 'livre' });

      decision('ETIQUETA', 'verificação_de_reparo', { chat: canonicalChatId, origem: 'primeira_mensagem' });
      await repairSessionServiceLabel(channel, canonicalChatId, repairedServiceLabels, 'primeira mensagem');

      const key = messageKey(raw || { from: canonicalChatId, text: effectiveText });
      if (processedMessageIds.has(key)) {
        decision('ENTRADA', 'ignorada', { chat: canonicalChatId, motivo: 'duplicada' });
        return;
      }
      processedMessageIds.add(key);
      if (processedMessageIds.size > 5000) {
        const first = processedMessageIds.values().next().value;
        processedMessageIds.delete(first);
      }

      const delayMs = resolveBufferDelay(canonicalChatId, raw, interactiveId);
      const runtimeProtection = getRuntimeProtectionState();
      decision('BUFFER', 'agendado', {
        chat: canonicalChatId,
        etapa: stage,
        espera: `${delayMs}ms`,
        ação: interactiveId || undefined,
        autoproteção: runtimeProtection.active ? runtimeProtection.level : undefined,
      });
      buffer.push(canonicalChatId, {
        text: effectiveText,
        raw,
        source,
        identity,
        profileName,
        interactiveId,
        delayMs,
        trace: { ...trace, chat: canonicalChatId, etapa: stage },
      }, { delayMs });
    });
  };

  if (env.mockMode) {
    channel = installDecisionChannelInstrumentation(installMessageExperience(createMockChannel()));
    blockPdfSending(channel);
    decision('CONEXÃO', 'mock_ativo', { status: 'pronto' });
    console.log('[PersonalizeWppConect] MOCK_MODE ativo.');
    return;
  }

  decision('CONEXÃO', 'criando_canal', { sessão: env.sessionName });
  channel = await createWppChannel({ onMessage, onOutgoingMessage });
  blockPdfSending(channel);
  installMessageExperience(channel);
  installDecisionChannelInstrumentation(channel);
  decision('CONEXÃO', 'canal_criado', { status: 'conectado', sessão: env.sessionName });
  decision('ETIQUETA', 'inicialização_iniciada', { origem: 'startup' });
  await initializeServiceLabels(channel).then(() => {
    decision('ETIQUETA', 'inicialização_concluída', { resultado: 'ok' });
  }).catch((err) => {
    decisionError('inicialização_de_etiquetas_falhou', err);
    console.warn('[LISTAS] preparação inicial falhou:', err?.message || err);
  });
  decision('RECUPERAÇÃO', 'reconciliação_de_etiquetas_iniciada', { origem: 'startup' });
  await reconcileActiveServiceLists(channel, repairedServiceLabels).then((result) => {
    decision('RECUPERAÇÃO', 'reconciliação_de_etiquetas_concluída', {
      quantidade: result?.found || 0,
      resultado: result?.skipped ? 'adiado' : 'ok',
    });
  }).catch((err) => {
    decisionError('reconciliação_de_etiquetas_falhou', err);
    console.warn('[LISTAS] recuperação das sessões ativas falhou:', err?.message || err);
  });
  decision('RECUPERAÇÃO', 'respostas_pendentes_iniciada', { origem: 'startup' });
  await recoverPendingActiveSessions(channel, onMessage).then((result) => {
    decision('RECUPERAÇÃO', 'respostas_pendentes_concluída', {
      quantidade: result?.recovered || 0,
      verificadas: result?.scanned || 0,
      resultado: 'ok',
    });
  }).catch((err) => {
    decisionError('respostas_pendentes_falhou', err);
    console.warn('[RETOMADA] recuperação de respostas pendentes falhou:', err?.message || err);
  });
  decision('SISTEMA', 'pronto_para_mensagens', { status: 'pronto' });
  console.log('[PersonalizeWppConect] conectado. Aguardando mensagens...');

  if (env.enableUnreadBootstrap) {
    console.log(`[PersonalizeWppConect] buscando mensagens não lidas em ${env.unreadBootstrapDelayMs}ms...`);
    setTimeout(async () => {
      try {
        decision('RECUPERAÇÃO', 'não_lidas_iniciada', { origem: 'unread_bootstrap' });
        const unread = await collectUnreadMessages(channel.client);
        decision('RECUPERAÇÃO', 'não_lidas_encontradas', { quantidade: unread.length });
        console.log(`[PersonalizeWppConect] mensagens não lidas encontradas: ${unread.length}`);
        for (const item of unread) {
          await onMessage({ from: item.from, text: item.text, raw: item.raw, source: 'unread-bootstrap' });
        }
      } catch (err) {
        decisionError('não_lidas_falhou', err);
        console.warn('[PersonalizeWppConect] não foi possível buscar mensagens não lidas:', err?.message || err);
      }
    }, env.unreadBootstrapDelayMs).unref?.();
  }
}

main().catch((err) => {
  decisionError('falha_fatal', err);
  console.error('[PersonalizeWppConect] erro fatal:', err?.stack || err?.message || err);
  process.exitCode = 1;
});
