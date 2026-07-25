'use strict';

const HumanControl = require('../services/humanControlStore');
const Access = require('./testCommandAccess');
const { decision } = require('./decisionLogger');
const { isStrictTesterIdentity } = require('./handoffPolicy');

function installStrictTesterIdentity() {
  Access.isTesterIdentity = function isTesterIdentityStrict(payload = {}) {
    return isStrictTesterIdentity(payload);
  };
}

function installTesterBlockProtection() {
  if (HumanControl.__strictTesterBlockProtectionInstalled) return;
  const originalSetBlock = HumanControl.setBlock.bind(HumanControl);

  HumanControl.setBlock = function setBlockExceptTester(clientId, payload = {}) {
    if (isStrictTesterIdentity({ from: clientId })) {
      try { HumanControl.clearBlock(clientId); } catch (_) {}
      decision('HANDOFF', 'bloqueio_ignorado_para_tester', {
        chat: clientId,
        status: 'livre',
        motivo: payload?.reason || 'handoff_candidate',
      });
      return {
        bypassed: true,
        reason: 'tester_identity',
        blockedUntil: null,
      };
    }
    return originalSetBlock(clientId, payload);
  };

  HumanControl.__strictTesterBlockProtectionInstalled = true;
}

installStrictTesterIdentity();
installTesterBlockProtection();

module.exports = {
  installStrictTesterIdentity,
  installTesterBlockProtection,
};
