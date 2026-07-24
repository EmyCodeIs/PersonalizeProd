'use strict';

const Store = require('../services/leadStore');

const CustomerFlow = require('../flow/customerFlow');
const originalProcessCustomerMessage = CustomerFlow.processCustomerMessage;

CustomerFlow.processCustomerMessage = async function processCustomerMessageAfterCompletion(args = {}) {
  const session = Store.getSession(args.clientId);
  const completed = Boolean(session?.completed || session?.dados?.botDone || session?.etapa === 'concluido');

  if (completed) {
    console.log(`[FLUXO] pré-atendimento concluído; mensagem deixada para o vendedor | cliente=${args.clientId}`);
    return session;
  }

  return originalProcessCustomerMessage(args);
};

module.exports = {
};
