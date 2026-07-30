'use strict';

const DecisionLogger = require('./decisionLogger');
const Lifecycle = require('./runtimeLifecycle');
const WppClient = require('../services/wppconnectClient');

function normalize(value) {
  return String(value || '').trim().toLowerCase();
}

function installDecisionTracking() {
  if (DecisionLogger.__runtimeLifecycleTrackingInstalled) return;

  const originalDecision = DecisionLogger.decision;
  DecisionLogger.decision = function decisionWithRuntimeLifecycle(category, event, fields = {}, level = 'log') {
    const result = originalDecision(category, event, fields, level);
    const normalizedCategory = normalize(category);
    const normalizedEvent = normalize(event);

    if (normalizedCategory === 'conexão' || normalizedCategory === 'conexao') {
      if (['estado_alterado', 'status_wppconnect'].includes(normalizedEvent)) {
        Lifecycle.markConnectionState(fields?.status || fields?.estado || 'UNKNOWN');
      }
      if (normalizedEvent === 'mock_ativo') Lifecycle.markReady({ mock: true });
    }

    if (normalizedCategory === 'sistema' && normalizedEvent === 'pronto_para_mensagens') {
      Lifecycle.markReady();
    }

    return result;
  };

  const originalDecisionError = DecisionLogger.decisionError;
  DecisionLogger.decisionError = function decisionErrorWithRuntimeLifecycle(event, error, fields = {}) {
    Lifecycle.recordError(error);
    if (normalize(event) === 'falha_fatal') Lifecycle.markFailed(error);
    return originalDecisionError(event, error, fields);
  };

  DecisionLogger.__runtimeLifecycleTrackingInstalled = true;
}

function installChannelTracking() {
  if (WppClient.__runtimeLifecycleChannelTrackingInstalled) return;

  const originalCreateWppChannel = WppClient.createWppChannel;
  WppClient.createWppChannel = async function createLifecycleAwareChannel(options = {}) {
    const originalOnMessage = options.onMessage;
    const originalOnOutgoingMessage = options.onOutgoingMessage;

    const channel = await originalCreateWppChannel({
      ...options,
      onMessage: async (payload = {}) => {
        Lifecycle.recordIncoming();
        if (!Lifecycle.isAcceptingMessages()) {
          DecisionLogger.decision('ENTRADA', 'ignorada_durante_encerramento', {
            chat: payload?.from || '-',
            motivo: 'runtime_shutting_down',
          }, 'warn');
          return false;
        }
        return originalOnMessage?.(payload);
      },
      onOutgoingMessage: async (payload = {}) => {
        Lifecycle.recordOutgoing();
        if (!Lifecycle.isAcceptingMessages()) {
          DecisionLogger.decision('HANDOFF', 'saída_ignorada_durante_encerramento', {
            chat: payload?.from || '-',
            motivo: 'runtime_shutting_down',
          }, 'warn');
          return false;
        }
        return originalOnOutgoingMessage?.(payload);
      },
    });

    Lifecycle.registerChannel(channel);
    return channel;
  };

  const originalCreateMockChannel = WppClient.createMockChannel;
  WppClient.createMockChannel = function createLifecycleAwareMockChannel(...args) {
    const channel = originalCreateMockChannel(...args);
    Lifecycle.registerChannel(channel, { mock: true });
    return channel;
  };

  WppClient.__runtimeLifecycleChannelTrackingInstalled = true;
}

function installSignalHandlers() {
  if (global.__personalizeGracefulSignalHandlersInstalled) return;

  const originalOnce = process.once;
  const handlers = new Map();

  for (const signal of ['SIGINT', 'SIGTERM']) {
    const handler = async () => {
      if (Lifecycle.snapshotState().phase === 'shutting_down') return;
      const result = await Lifecycle.gracefulShutdown({ signal });
      const code = result?.forced ? 1 : 0;
      process.exitCode = code;
      setImmediate(() => process.exit(code));
    };
    handlers.set(signal, handler);
    originalOnce.call(process, signal, handler);
  }

  // O bootstrap legado registra handlers que chamam process.exit imediatamente.
  // Eles são removidos depois que toda a cadeia síncrona de requires termina.
  queueMicrotask(() => {
    for (const signal of ['SIGINT', 'SIGTERM']) {
      for (const listener of process.listeners(signal)) {
        if (listener === handlers.get(signal)) continue;
        const source = String(listener || '');
        if (source.includes('stopWindowsSessionAccess') && source.includes('process.exit')) {
          process.removeListener(signal, listener);
        }
      }
    }
  });

  global.__personalizeGracefulSignalHandlersInstalled = true;
}

installDecisionTracking();
installChannelTracking();
installSignalHandlers();

module.exports = {
  installChannelTracking,
  installDecisionTracking,
  installSignalHandlers,
};
