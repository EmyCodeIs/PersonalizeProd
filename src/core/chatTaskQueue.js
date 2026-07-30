'use strict';

const { decision, decisionError } = require('./decisionLogger');

function configuredConcurrentChats(fallback) {
  try {
    const { env } = require('../config/env');
    const value = Number(env?.maxConcurrentChats);
    if (Number.isFinite(value) && value > 0) return value;
  } catch (_) {}
  return fallback;
}

class ChatTaskQueue {
  constructor({
    maxUnits = 2,
    maxConcurrentChats,
    maxQueueSize = 40,
    taskTimeoutMs = 45000,
  } = {}) {
    this.maxUnits = Math.max(1, Number(maxUnits || 1));
    this.maxConcurrentChats = Math.max(
      1,
      Number(maxConcurrentChats || configuredConcurrentChats(2)),
    );
    this.maxQueueSize = Math.max(1, Number(maxQueueSize || 1));
    this.taskTimeoutMs = Math.max(10, Number(taskTimeoutMs || 0));
    this.runningUnits = 0;
    this.queue = [];
    this.runningChats = new Set();
    this.runningItems = new Map();
    this.sequence = 0;
  }

  stats() {
    let timedOutTasks = 0;
    for (const item of this.runningItems.values()) {
      if (item.timedOut) timedOutTasks += 1;
    }
    return {
      runningUnits: this.runningUnits,
      activeChats: this.runningChats.size,
      runningTasks: this.runningItems.size,
      timedOutTasks,
      queued: this.queue.length,
      limit: this.maxUnits,
      maxConcurrentChats: this.maxConcurrentChats,
      maxQueueSize: this.maxQueueSize,
    };
  }

  cancelQueuedForChats(chatIds = [], code = 'QUEUE_CANCELLED') {
    const selected = new Set(
      (Array.isArray(chatIds) ? chatIds : [chatIds])
        .map((item) => String(item || '').trim())
        .filter(Boolean),
    );
    if (!selected.size) return 0;

    const retained = [];
    const cancelled = [];
    for (const item of this.queue) {
      if (selected.has(item.chatId)) cancelled.push(item);
      else retained.push(item);
    }
    this.queue = retained;

    for (const item of cancelled) {
      if (item.publicSettled) continue;
      item.publicSettled = true;
      const error = new Error(`Tarefa cancelada: ${code}.`);
      error.code = code;
      error.chatId = item.chatId;
      item.reject(error);
    }
    return cancelled.length;
  }

  cancelRunningForChats(chatIds = [], code = 'QUEUE_RUNNING_CANCELLED') {
    const selected = new Set(
      (Array.isArray(chatIds) ? chatIds : [chatIds])
        .map((item) => String(item || '').trim())
        .filter(Boolean),
    );
    let signalled = 0;
    for (const item of this.runningItems.values()) {
      if (!selected.has(item.chatId) || item.controller.signal.aborted) continue;
      const error = new Error(`Tarefa sinalizada para cancelamento: ${code}.`);
      error.code = code;
      error.chatId = item.chatId;
      item.controller.abort(error);
      signalled += 1;
    }
    return signalled;
  }

  enqueue(chatId, task, options = {}) {
    const normalizedChatId = String(chatId || '').trim();
    if (!normalizedChatId) {
      return Promise.reject(new Error('chatId inválido para a fila global.'));
    }
    if (typeof task !== 'function') {
      return Promise.reject(new Error('A fila global recebeu uma tarefa inválida.'));
    }
    if (this.queue.length >= this.maxQueueSize) {
      const error = new Error(`Fila global cheia (${this.maxQueueSize}).`);
      error.code = 'QUEUE_FULL';
      error.chatId = normalizedChatId;
      return Promise.reject(error);
    }

    const timeoutMs = Math.max(10, Number(options.timeoutMs || this.taskTimeoutMs));
    const units = Math.max(0, Math.min(this.maxUnits, Number(options.units ?? 1)));

    return new Promise((resolve, reject) => {
      this.queue.push({
        id: ++this.sequence,
        chatId: normalizedChatId,
        task,
        timeoutMs,
        units,
        resolve,
        reject,
        publicSettled: false,
        unitsReleased: false,
        chatReleased: false,
        timedOut: false,
        controller: new AbortController(),
      });
      this.processNext();
    });
  }

  processNext() {
    while (this.runningChats.size < this.maxConcurrentChats) {
      const index = this.queue.findIndex((item) => (
        !this.runningChats.has(item.chatId)
        && (this.runningUnits + item.units) <= this.maxUnits
      ));
      if (index < 0) return;

      const item = this.queue.splice(index, 1)[0];
      this.runningUnits += item.units;
      this.runningChats.add(item.chatId);
      this.runningItems.set(item.id, item);
      this.executeItem(item);
    }
  }

  releaseUnits(item) {
    if (item.unitsReleased) return;
    item.unitsReleased = true;
    this.runningUnits = Math.max(0, this.runningUnits - item.units);
  }

  releaseChat(item) {
    if (item.chatReleased) return;
    item.chatReleased = true;
    this.runningChats.delete(item.chatId);
  }

  finishItem(item) {
    this.releaseUnits(item);
    this.releaseChat(item);
    this.runningItems.delete(item.id);
  }

  timeoutItem(item) {
    if (item.publicSettled) return;
    item.publicSettled = true;
    item.timedOut = true;

    const error = new Error(`Timeout ao processar o chat ${item.chatId}.`);
    error.code = 'QUEUE_TIMEOUT';
    error.chatId = item.chatId;
    error.taskId = item.id;

    // Libera somente a capacidade global. O lock do chat e as tarefas seguintes
    // permanecem preservados até a operação real terminar, sem perder mensagens.
    this.releaseUnits(item);
    item.controller.abort(error);
    const waitingSameChat = this.queue.filter((queued) => queued.chatId === item.chatId).length;
    item.reject(error);

    decision('FILA', 'timeout_isolado', {
      chat: item.chatId,
      tarefa: item.id,
      quantidade: waitingSameChat,
      resultado: 'capacidade_global_liberada_chat_e_tarefas_preservados',
    }, 'warn');
    this.processNext();
  }

  executeItem(item) {
    let timeoutHandle = null;

    if (item.timeoutMs) {
      timeoutHandle = setTimeout(() => this.timeoutItem(item), item.timeoutMs);
      if (typeof timeoutHandle.unref === 'function') timeoutHandle.unref();
    }

    Promise.resolve()
      .then(() => item.task({
        signal: item.controller.signal,
        chatId: item.chatId,
        taskId: item.id,
      }))
      .then((result) => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        this.finishItem(item);
        if (!item.publicSettled) {
          item.publicSettled = true;
          item.resolve(result);
        }
        this.processNext();
      })
      .catch((error) => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        this.finishItem(item);
        if (!item.publicSettled) {
          item.publicSettled = true;
          item.reject(error);
        } else {
          decisionError('fila_falhou_após_timeout', error, { chat: item.chatId, tarefa: item.id });
          console.warn(
            `[QUEUE] tarefa ${item.id} do chat ${item.chatId} falhou depois do timeout:`,
            error?.message || error,
          );
        }
        this.processNext();
      });
  }
}

module.exports = { ChatTaskQueue };