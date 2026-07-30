'use strict';

const WppClient = require('../services/wppconnectClient');
const {
  classifyCorruptLabelName,
  labelNamePreview,
} = require('./labelCorruptionPolicy');
const { decision, decisionError } = require('./decisionLogger');

function boolEnv(name, fallback = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === '') return fallback;
  return ['1', 'true', 'yes', 'sim', 'on'].includes(String(raw).trim().toLowerCase());
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms || 0))));
}

async function readLabels(channel) {
  const client = channel?.client;
  if (!client?.page?.evaluate) throw new Error('LABEL_PAGE_UNAVAILABLE');

  return client.page.evaluate(async () => {
    const WPP = window.WPP || null;
    if (typeof WPP?.labels?.getAllLabels !== 'function') throw new Error('LABEL_API_UNAVAILABLE');
    const raw = await WPP.labels.getAllLabels();
    const labels = Array.isArray(raw) ? raw : Object.values(raw || {});
    return labels.map((item) => ({
      id: String(item?.id?._serialized || item?.id || item?.labelId || '').trim(),
      name: String(item?.name || item?.label || ''),
      count: Number(item?.count || 0),
    }));
  });
}

async function deleteLabelById(channel, id) {
  const client = channel?.client;
  const labelId = String(id || '').trim();
  if (!labelId) return { ok: false, reason: 'LABEL_ID_UNAVAILABLE' };
  if (!client?.page?.evaluate) return { ok: false, reason: 'LABEL_PAGE_UNAVAILABLE' };

  try {
    const submitted = await client.page.evaluate(async ({ labelId: targetId }) => {
      const WPP = window.WPP || null;
      if (typeof WPP?.labels?.deleteLabel !== 'function') {
        return { submitted: false, reason: 'DELETE_LABEL_API_UNAVAILABLE' };
      }
      try {
        const response = await WPP.labels.deleteLabel(targetId);
        return { submitted: true, response };
      } catch (error) {
        return {
          submitted: false,
          reason: String(error?.message || error?.text || error || 'DELETE_LABEL_FAILED'),
        };
      }
    }, { labelId });

    await wait(1200);
    const remaining = await readLabels(channel);
    const stillExists = remaining.some((item) => String(item.id) === labelId);
    return {
      ok: !stillExists,
      submitted: submitted?.submitted === true,
      reason: stillExists
        ? (submitted?.reason || `etiqueta ID=${labelId} ainda existe após deleteLabel`)
        : null,
    };
  } catch (error) {
    return { ok: false, reason: error?.message || String(error) };
  }
}

async function repairCorruptSymbolLabelsOnce(channel) {
  if (!boolEnv('LABEL_MAINTENANCE_ENABLED', true)) return { audited: 0, corrupt: 0, removed: 0 };

  const autoRemove = boolEnv('LABEL_MAINTENANCE_AUTO_REMOVE_CORRUPT_SYMBOLS', false);
  const confirmed = String(process.env.LABEL_MAINTENANCE_CONFIRM_DELETE || '').trim() === 'CONFIRMAR_EXCLUSAO';
  let labels;

  try {
    labels = await readLabels(channel);
  } catch (error) {
    decisionError('auditoria_de_etiquetas_corrompidas_falhou', error);
    console.warn('[LISTAS][SÍMBOLOS] não foi possível ler as etiquetas:', error?.message || error);
    return { audited: 0, corrupt: 0, removed: 0, error: error?.message || String(error) };
  }

  const corrupt = labels
    .map((label) => ({ ...label, classification: classifyCorruptLabelName(label.name) }))
    .filter((label) => label.classification.corrupt);

  let removed = 0;
  let failed = 0;

  for (const label of corrupt) {
    const reasons = label.classification.reasons.join(',');
    console.warn(
      `[LISTAS][SÍMBOLOS] etiqueta corrompida encontrada | ID=${label.id || '-'} `
      + `| nome=${labelNamePreview(label.name)} | motivos=${reasons} `
      + `| conversas=${Number(label.count || 0)} | remoçãoAutomática=${autoRemove && confirmed ? 'ativada' : 'desativada'}`,
    );
    decision('ETIQUETA', 'corrompida_encontrada', {
      etiqueta: labelNamePreview(label.name),
      id: label.id || '-',
      motivo: reasons,
      quantidade: Number(label.count || 0),
      ação: autoRemove && confirmed ? 'remover' : 'auditar',
    }, 'warn');

    if (!autoRemove || !confirmed) continue;
    const result = await deleteLabelById(channel, label.id);
    if (result.ok) {
      removed += 1;
      console.log(`[LISTAS][SÍMBOLOS] etiqueta corrompida removida | ID=${label.id} | nome=${labelNamePreview(label.name)}`);
      decision('ETIQUETA', 'corrompida_removida', {
        etiqueta: labelNamePreview(label.name),
        id: label.id,
        resultado: 'removida',
      });
    } else {
      failed += 1;
      console.error(
        `[LISTAS][SÍMBOLOS] falha ao remover etiqueta corrompida | ID=${label.id || '-'} `
        + `| nome=${labelNamePreview(label.name)} | motivo=${result.reason || 'desconhecido'}`,
      );
      decision('ETIQUETA', 'corrompida_remoção_falhou', {
        etiqueta: labelNamePreview(label.name),
        id: label.id || '-',
        erro: result.reason || 'desconhecido',
      }, 'error');
    }
  }

  console.log(
    `[LISTAS][SÍMBOLOS] auditoria concluída | verificadas=${labels.length} `
    + `| corrompidas=${corrupt.length} | removidas=${removed} | falhas=${failed}`,
  );

  return { audited: labels.length, corrupt: corrupt.length, removed, failed };
}

function installCorruptLabelMaintenance() {
  if (WppClient.__corruptLabelMaintenanceInstalled) return;
  const originalCreateWppChannel = WppClient.createWppChannel;

  WppClient.createWppChannel = async function createWppChannelWithCorruptLabelMaintenance(options = {}) {
    const channel = await originalCreateWppChannel(options);
    try {
      await repairCorruptSymbolLabelsOnce(channel);
    } catch (error) {
      decisionError('manutenção_de_etiquetas_corrompidas_falhou', error);
      console.error('[LISTAS][SÍMBOLOS] falha isolada; atendimento continua:', error?.stack || error?.message || error);
    }
    return channel;
  };

  WppClient.__corruptLabelMaintenanceInstalled = true;
}

installCorruptLabelMaintenance();

module.exports = {
  deleteLabelById,
  installCorruptLabelMaintenance,
  readLabels,
  repairCorruptSymbolLabelsOnce,
};
