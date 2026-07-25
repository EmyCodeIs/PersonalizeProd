'use strict';

const BotActivity = require('../services/botActivityStore');
const HumanControl = require('../services/humanControlStore');
const Identity = require('../services/contactIdentity');
const Store = require('../services/leadStore');

const runtime = { buffers: new Set(), queues: new Set(), installed: false };

function candidateIds(clientId) {
  const values = [clientId];
  try {
    if (typeof Identity.getLabelCandidateIds === 'function') values.push(...Identity.getLabelCandidateIds(clientId));
  } catch (_) {}
  return [...new Set(values.map((item) => Identity.normalizeChatId(item)).filter(Boolean))];
}

function clearHumanBlocks(clientId) {
  let cleared = 0;
  for (const candidate of candidateIds(clientId)) {
    try { if (HumanControl.clearBlock(candidate)) cleared += 1; } catch (_) {}
  }
  return cleared;
}

function installRuntimeTracking() {
  if (runtime.installed) return;
  const BufferModule = require('./bufferManager');
  const QueueModule = require('./chatTaskQueue');
  const OriginalBuffer = BufferModule.BufferManager;
  const OriginalQueue = QueueModule.ChatTaskQueue;

  class TrackedBufferManager extends OriginalBuffer {
    constructor(...args) {
      super(...args);
      runtime.buffers.add(this);
    }
  }
  class TrackedChatTaskQueue extends OriginalQueue {
    constructor(...args) {
      super(...args);
      runtime.queues.add(this);
    }
  }

  BufferModule.BufferManager = TrackedBufferManager;
  QueueModule.ChatTaskQueue = TrackedChatTaskQueue;
  runtime.installed = true;
}

function clearTesterConversationRuntime(clientId) {
  const candidates = candidateIds(clientId);
  let discardedBuffers = 0;
  let cancelledTasks = 0;

  for (const buffer of runtime.buffers) {
    for (const candidate of candidates) discardedBuffers += Number(buffer?.clear?.(candidate) || 0);
  }
  for (const queue of runtime.queues) {
    cancelledTasks += Number(queue?.cancelQueuedForChats?.(candidates, 'RESETARSYS') || 0);
  }

  const blocksCleared = clearHumanBlocks(clientId);
  const activityCleared = Number(BotActivity.clearContact?.(clientId) || 0);
  const rawReset = typeof Store.resetConversation === 'function'
    ? Store.resetConversation(clientId)
    : (Store.resetSession(clientId), { sessionRemoved: true, profileRemoved: false });
  const reset = rawReset?.reset === true ? rawReset : { reset: true, ...(rawReset || {}) };

  return { candidates, discardedBuffers, cancelledTasks, blocksCleared, activityCleared, reset };
}

installRuntimeTracking();

module.exports = {
  candidateIds,
  clearHumanBlocks,
  clearTesterConversationRuntime,
  installRuntimeTracking,
  _test: { runtime },
};
