'use strict';

const path = require('path');
const WppClient = require('../services/wppconnectClient');
const CustomerFlow = require('../flow/customerFlow');
const Ledger = require('../services/outboundLedgerStore');
const Context = require('./outboundLedgerContext');
const { leadOperationsConfig } = require('../config/leadOperationsConfig');

function clean(value, maxLength = 12000) {
  const text = String(value ?? '').trim();
  return text ? text.slice(0, maxLength) : '';
}

function inboxIdFromMessage(message = {}) {
  return clean(
    message?.raw?.__personalizeInboxId
    || message?.__personalizeInboxId
    || '',
    260,
  ) || null;
}

function inboxIds(messages = []) {
  return [...new Set((messages || []).map(inboxIdFromMessage).filter(Boolean))];
}

function optionsFor(method, args = []) {
  if (method === 'sendText') return args[2] && typeof args[2] === 'object' ? args[2] : {};
  if (method === 'sendImage') return args[3] && typeof args[3] === 'object' ? args[3] : {};
  if (method === 'sendDocument') return args[4] && typeof args[4] === 'object' ? args[4] : {};
  return {};
}

function channelDescriptor(method, args = []) {
  const options = optionsFor(method, args);
  if (method === 'sendText') {
    return {
      conversationId: args[0],
      type: 'text',
      text: clean(args[1]),
      source: options.ledgerSource || 'channel.sendText',
      operationKey: options.ledgerOperationKey,
    };
  }
  if (method === 'sendImage') {
    return {
      conversationId: args[0],
      type: 'image',
      caption: clean(args[2]),
      filename: path.basename(clean(args[1], 1000) || 'imagem'),
      source: options.ledgerSource || 'channel.sendImage',
      operationKey: options.ledgerOperationKey,
    };
  }
  return {
    conversationId: args[0],
    type: 'document',
    caption: clean(args[3]),
    filename: clean(args[2], 500) || path.basename(clean(args[1], 1000) || 'documento'),
    source: options.ledgerSource || 'channel.sendDocument',
    operationKey: options.ledgerOperationKey,
  };
}

function clientDescriptor(method, args = []) {
  const chatId = args[0];
  if (method === 'sendText') {
    return { conversationId: chatId, type: 'text', text: clean(args[1]), source: 'client.sendText' };
  }
  if (method === 'sendImage') {
    return {
      conversationId: chatId,
      type: 'image',
      filename: clean(args[2], 500) || path.basename(clean(args[1], 1000) || 'imagem'),
      caption: clean(args[3]),
      source: 'client.sendImage',
    };
  }
  if (method === 'sendFile') {
    return {
      conversationId: chatId,
      type: 'document',
      filename: clean(args[2], 500) || path.basename(clean(args[1], 1000) || 'documento'),
      caption: clean(args[3]),
      source: 'client.sendFile',
    };
  }
  const payload = args[1] || {};
  return {
    conversationId: chatId,
    type: 'list',
    text: clean([
      payload.title,
      payload.description,
      payload.buttonText,
      ...(payload.sections || []).flatMap((section) => [
        section?.title,
        ...(section?.rows || []).map((row) => `${row?.title || ''} ${row?.description || ''}`),
      ]),
    ].filter(Boolean).join(' | '), 12000),
    source: 'client.sendListMessage',
  };
}

function withOperation(descriptor = {}) {
  const operation = Context.nextOperation(descriptor);
  return {
    ...descriptor,
    operationKey: operation.operationKey,
    sequence: operation.sequence,
    inboxIds: operation.inboxIds,
    source: descriptor.source || operation.source,
  };
}

function wrapChannelMethod(channel, method) {
  if (typeof channel?.[method] !== 'function') return;
  const marker = `__outboundLedgerWrapped_${method}`;
  if (channel[marker]) return;
  const original = channel[method].bind(channel);

  channel[method] = async (...args) => {
    const descriptor = withOperation(channelDescriptor(method, args));
    return Ledger.dispatch(descriptor, () => Context.runSuppressClientLedger(() => original(...args)));
  };
  channel[marker] = true;
}

function wrapClientMethod(client, method) {
  if (typeof client?.[method] !== 'function') return;
  const marker = `__outboundLedgerWrapped_${method}`;
  if (client[marker]) return;
  const original = client[method].bind(client);

  client[method] = async (...args) => {
    if (Context.clientLedgerSuppressed()) return original(...args);
    const descriptor = withOperation(clientDescriptor(method, args));
    return Ledger.dispatch(descriptor, () => original(...args));
  };
  client[marker] = true;
}

function attachTxtSender(channel) {
  if (!channel || channel.sendTxtDocument) return;
  channel.sendTxtDocument = async (clientId, filePath, fileName, caption = '', options = {}) => {
    if (typeof channel?.client?.sendFile !== 'function') {
      const error = new Error('CLIENT_SEND_FILE_UNAVAILABLE');
      error.code = 'CLIENT_SEND_FILE_UNAVAILABLE';
      throw error;
    }
    const descriptor = withOperation({
      conversationId: clientId,
      type: 'text_document',
      filename: clean(fileName, 500) || path.basename(filePath),
      caption: clean(caption),
      source: options.ledgerSource || 'lead_alert_txt',
      operationKey: options.ledgerOperationKey,
    });
    return Ledger.dispatch(descriptor, () => Context.runSuppressClientLedger(() => (
      channel.client.sendFile(clientId, filePath, descriptor.filename, caption)
    )));
  };
}

function wrapChannel(channel) {
  if (!channel || channel.__outboundLedgerInstalled) return channel;
  for (const method of ['sendText', 'sendImage', 'sendDocument']) wrapChannelMethod(channel, method);
  for (const method of ['sendText', 'sendImage', 'sendFile', 'sendListMessage']) {
    wrapClientMethod(channel.client, method);
  }
  attachTxtSender(channel);
  channel.__outboundLedgerStats = () => Ledger.stats();
  channel.__outboundLedgerConversation = (clientId, options = {}) => Ledger.listConversation(clientId, options);
  channel.__outboundLedgerInstalled = true;
  return channel;
}

function installFlowContext() {
  if (CustomerFlow.__outboundLedgerContextInstalled) return;
  const original = CustomerFlow.processCustomerMessage;
  CustomerFlow.processCustomerMessage = async function processCustomerMessageWithOutboundContext(args = {}) {
    const ids = inboxIds(args.messages || []);
    return Context.runForInboundBatch({
      conversationId: args.clientId,
      inboxIds: ids,
      source: 'customer_flow',
    }, () => original(args));
  };
  CustomerFlow.__outboundLedgerContextInstalled = true;
}

function startMaintenance() {
  if (global.__personalizeOutboundLedgerMaintenanceTimer) return;
  const stale = Ledger.markStalePendingUncertain();
  if (stale) console.warn(`[LEDGER SAÍDA] ${stale} envio(s) pendente(s) movido(s) para revisão manual.`);
  const timer = setInterval(() => {
    try {
      Ledger.markStalePendingUncertain();
      const result = Ledger.purge();
      if (result.removed) console.log(`[LEDGER SAÍDA] manutenção removeu ${result.removed} registro(s).`);
    } catch (error) {
      console.warn('[LEDGER SAÍDA] falha na manutenção:', error?.message || error);
    }
  }, 900000);
  timer.unref?.();
  global.__personalizeOutboundLedgerMaintenanceTimer = timer;
}

function installOutboundLedger() {
  if (!leadOperationsConfig.outboundLedgerEnabled) return WppClient;
  installFlowContext();
  if (WppClient.__outboundLedgerPreloadInstalled) return WppClient;
  const originalCreate = WppClient.createWppChannel.bind(WppClient);
  WppClient.createWppChannel = async function createChannelWithOutboundLedger(options = {}) {
    const channel = await originalCreate(options);
    wrapChannel(channel);
    startMaintenance();
    console.log('[LEDGER SAÍDA] persistente ativo para textos, listas, imagens e documentos.');
    return channel;
  };
  WppClient.__outboundLedgerPreloadInstalled = true;
  return WppClient;
}

installOutboundLedger();

module.exports = {
  attachTxtSender,
  channelDescriptor,
  clientDescriptor,
  inboxIds,
  installFlowContext,
  installOutboundLedger,
  wrapChannel,
};
