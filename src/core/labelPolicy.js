'use strict';

const { env } = require('../config/env');

const LABEL_CATEGORY = Object.freeze({
  OPERATIONAL: 'operational',
  SELLER: 'seller',
  MANUAL: 'manual',
  UNKNOWN: 'unknown',
});

function normalizeName(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function operationalLabelNames() {
  return new Set([
    env.serviceLabelLetreiro,
    env.serviceLabelPlotagem,
    env.serviceLabelOutros,
    env.supportLabelName,
    ...(Array.isArray(env.serviceLabelReplaceGroup) ? env.serviceLabelReplaceGroup : []),
  ].map(normalizeName).filter(Boolean));
}

function sellerLabelMap() {
  return new Map(
    Object.keys(env.sellerLabelRules || {})
      .map((name) => [normalizeName(name), name])
      .filter(([normalized]) => Boolean(normalized)),
  );
}

function classifyLabel(value) {
  const name = String(value?.name || value?.label || value || '').trim();
  const normalized = normalizeName(name);
  if (!normalized) {
    return {
      category: LABEL_CATEGORY.UNKNOWN,
      blocks: false,
      reason: null,
      name: null,
      normalized: '',
      seller: null,
    };
  }

  if (operationalLabelNames().has(normalized)) {
    return {
      category: LABEL_CATEGORY.OPERATIONAL,
      blocks: false,
      reason: null,
      name,
      normalized,
      seller: null,
    };
  }

  const seller = sellerLabelMap().get(normalized) || null;
  if (seller) {
    return {
      category: LABEL_CATEGORY.SELLER,
      blocks: true,
      reason: 'seller_label',
      name,
      normalized,
      seller,
    };
  }

  return {
    category: LABEL_CATEGORY.MANUAL,
    blocks: true,
    reason: 'manual_label',
    name,
    normalized,
    seller: null,
  };
}

function firstBlockingLabel(labels = []) {
  for (const label of labels || []) {
    const classification = classifyLabel(label);
    if (classification.blocks) return { label, ...classification };
  }
  return null;
}

function selectLabelIdsForReset(labels = [], options = {}) {
  const mode = String(options.mode || 'TESTER_FULL').trim().toUpperCase();
  const getId = (item) => String(
    item?.id?._serialized
    || item?.id
    || item?.labelId
    || ''
  ).trim();

  return [...new Set((labels || [])
    .filter((item) => {
      if (mode === 'TESTER_FULL') return true;
      return classifyLabel(item).category === LABEL_CATEGORY.OPERATIONAL;
    })
    .map(getId)
    .filter(Boolean))];
}

module.exports = {
  LABEL_CATEGORY,
  classifyLabel,
  firstBlockingLabel,
  normalizeName,
  operationalLabelNames,
  selectLabelIdsForReset,
  sellerLabelMap,
};
