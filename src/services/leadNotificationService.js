'use strict';

const path = require('path');
const LeadReport = require('./leadAbandonmentReport');
const Operations = require('./leadOperationStore');
const { leadOperationsConfig } = require('../config/leadOperationsConfig');

function clean(value, maxLength = 1000) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, maxLength) : '';
}

function panelUrl() {
  return leadOperationsConfig.panelPublicUrl || '/leads';
}

function formatSummary(lead = {}) {
  const first = lead.firstMessages?.[0]?.text || lead.transcript?.find((item) => item.actor === 'CLIENTE')?.text || '-';
  return [
    'LEAD PARADO HÁ 24H',
    '',
    `Nome: ${lead.customerName || 'Não identificado'}`,
    `Contato: ${lead.phone || lead.clientId || '-'}`,
    `Serviço: ${lead.service || '-'}`,
    `Etapa: ${lead.stage || '-'}`,
    `Tempo parado: ${Number(lead.idleHours || 0)} hora(s)`,
    `Primeira mensagem: ${clean(first, 350)}`,
    '',
    `Painel: ${panelUrl()}`,
  ].join('\n');
}

async function sendToRecipient(channel, recipient, lead, reportFile) {
  const baseKey = `lead-alert:${lead.operationId}:${recipient}`;
  await channel.sendText(recipient, formatSummary(lead), {
    noDelay: true,
    noTyping: true,
    ledgerOperationKey: `${baseKey}:summary`,
    ledgerSource: 'lead_alert_24h',
  });

  if (leadOperationsConfig.alertSendTxt) {
    if (typeof channel.sendTxtDocument !== 'function') {
      const error = new Error('SEND_TXT_DOCUMENT_UNAVAILABLE');
      error.code = 'SEND_TXT_DOCUMENT_UNAVAILABLE';
      throw error;
    }
    await channel.sendTxtDocument(
      recipient,
      reportFile,
      path.basename(reportFile),
      `Conversa completa do lead ${lead.customerName || lead.phone || ''}`.trim(),
      {
        ledgerOperationKey: `${baseKey}:txt`,
        ledgerSource: 'lead_alert_24h_txt',
      },
    );
  }
}

async function runLeadAlerts(channel, options = {}) {
  if (!leadOperationsConfig.alertEnabled) return { skipped: true, reason: 'DISABLED' };
  const report = LeadReport.buildReport(options);
  const recipients = [...new Set((options.recipients || leadOperationsConfig.alertRecipients).map((item) => clean(item, 260)).filter(Boolean))];
  const eligible = report.leads
    .filter((lead) => lead.needsNotification)
    .slice(0, Math.max(1, Number(options.limit || leadOperationsConfig.alertMaxPerRun)));

  const result = {
    skipped: false,
    found: report.leads.length,
    eligible: eligible.length,
    sent: 0,
    failed: 0,
    panelPending: 0,
    recipients,
  };

  if (!recipients.length) {
    for (const lead of eligible) {
      const operation = Operations.getById(lead.operationId);
      if (operation?.alertStatus !== 'PANEL_PENDING') {
        Operations.recordAlert({
          id: lead.operationId,
          status: 'PANEL_PENDING',
          countAttempt: false,
          source: 'lead_alert_monitor',
          note: 'Lead disponibilizado no painel; nenhum destinatário de WhatsApp foi configurado.',
        });
      }
      result.panelPending += 1;
    }
    if (eligible.length) {
      console.log(`[LEADS 24H] ${eligible.length} lead(s) pendente(s) disponível(is) no painel; destinatário WhatsApp não configurado.`);
    }
    return result;
  }

  if (!channel?.sendText) return { ...result, skipped: true, reason: 'CHANNEL_UNAVAILABLE' };

  for (const lead of eligible) {
    let reportFile = null;
    try {
      reportFile = LeadReport.writeLeadTxt(lead).filePath;
      for (const recipient of recipients) {
        await sendToRecipient(channel, recipient, lead, reportFile);
      }
      LeadReport.markNotified(lead.conversationKey, {
        lastCustomerMessageAt: lead.lastCustomerMessageAt,
        channel: 'whatsapp',
        reportId: lead.operationId,
      });
      Operations.recordAlert({
        id: lead.operationId,
        status: 'SENT',
        recipients,
        reportPath: reportFile,
        source: 'lead_alert_monitor',
      });
      result.sent += 1;
      console.log(`[LEADS 24H] aviso enviado | lead=${lead.operationId} | destinatários=${recipients.length}`);
    } catch (error) {
      Operations.recordAlert({
        id: lead.operationId,
        status: 'FAILED',
        recipients,
        reportPath: reportFile,
        source: 'lead_alert_monitor',
        note: error?.message || String(error),
      });
      result.failed += 1;
      console.warn(`[LEADS 24H] falha ao enviar aviso | lead=${lead.operationId}:`, error?.message || error);
    }
  }

  return result;
}

module.exports = {
  formatSummary,
  panelUrl,
  runLeadAlerts,
  sendToRecipient,
};
