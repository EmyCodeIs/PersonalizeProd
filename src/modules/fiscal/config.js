'use strict';

const fs = require('node:fs');
const path = require('node:path');

function loadDotEnv(filePath = path.resolve(process.cwd(), '.env')) {
  if (!fs.existsSync(filePath)) return;
  const override = ['1', 'true', 'yes', 'sim', 'on'].includes(String(process.env.PERSONALIZE_ENV_OVERRIDE || '').toLowerCase());
  const content = fs.readFileSync(filePath, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index < 1) continue;
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (override || !(key in process.env)) process.env[key] = value;
  }
}

function bool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'sim', 'on'].includes(String(value).toLowerCase());
}

function number(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function text(value, fallback = '') {
  const parsed = String(value ?? '').trim();
  return parsed || fallback;
}

function timezoneOffset(value, fallback = '-03:00') {
  const parsed = text(value, fallback);
  if (!/^[+-](?:0\d|1\d|2[0-3]):[0-5]\d$/.test(parsed)) {
    throw new Error('COMPANY_TIMEZONE_OFFSET deve usar o formato -03:00.');
  }
  return parsed;
}

function createConfig() {
  loadDotEnv();
  const root = process.cwd();
  const environment = process.env.FOCUS_ENVIRONMENT === 'producao' ? 'producao' : 'homologacao';
  const demoMode = bool(process.env.DEMO_MODE, true);
  const allowProduction = bool(process.env.ALLOW_PRODUCTION, false);
  const runtimeMode = demoMode ? 'demonstracao' : environment;
  const panelSessionSecret = text(process.env.PANEL_SESSION_SECRET || process.env.SESSION_SECRET);
  const panelAdminPassword = text(process.env.PANEL_ADMIN_PASSWORD || process.env.ADMIN_PASSWORD);
  const focusToken = environment === 'producao'
    ? (process.env.FOCUS_TOKEN_PRODUCAO || process.env.FOCUS_TOKEN || '')
    : (process.env.FOCUS_TOKEN_HOMOLOGACAO || process.env.FOCUS_TOKEN || '');
  const legacySeries = number(process.env.DPS_SERIES, 1);
  const dpsSeries = environment === 'producao'
    ? number(process.env.DPS_SERIES_PRODUCAO, legacySeries)
    : number(process.env.DPS_SERIES_HOMOLOGACAO, legacySeries);

  if (!demoMode && !focusToken) {
    const error = new Error(`Token da Focus ausente para ${environment}.`);
    error.code = 'FOCUS_TOKEN_MISSING';
    throw error;
  }
  if (!demoMode && environment === 'producao' && !allowProduction) {
    const error = new Error('Produção bloqueada por segurança. Defina ALLOW_PRODUCTION=true somente após concluir a homologação.');
    error.code = 'PRODUCTION_NOT_ALLOWED';
    throw error;
  }
  if (!demoMode && environment === 'producao') {
    if (panelSessionSecret.length < 32) {
      const error = new Error('Produção exige PANEL_SESSION_SECRET com pelo menos 32 caracteres.');
      error.code = 'PRODUCTION_SESSION_SECRET_WEAK';
      throw error;
    }
    if (panelAdminPassword.length < 8 || ['2580', 'mudeessasenha123!', 'troque-a-senha-inicial', 'troque-por-uma-senha-forte'].includes(panelAdminPassword.toLowerCase())) {
      const error = new Error('Produção exige uma senha administrativa forte e diferente da senha inicial.');
      error.code = 'PRODUCTION_ADMIN_PASSWORD_WEAK';
      throw error;
    }
  }

  const webhookSecret = text(process.env.FOCUS_WEBHOOK_SECRET);
  if (webhookSecret && webhookSecret.length < 24) {
    const error = new Error('FOCUS_WEBHOOK_SECRET deve possuir pelo menos 24 caracteres.');
    error.code = 'WEBHOOK_SECRET_WEAK';
    throw error;
  }

  return Object.freeze({
    host: process.env.FISCAL_INTERNAL_HOST || '127.0.0.1',
    port: number(process.env.FISCAL_INTERNAL_PORT, 3031),
    appName: process.env.FISCAL_APP_NAME || 'Personalize NF',
    sessionSecret: panelSessionSecret || 'desenvolvimento-altere-esta-chave',
    admin: {
      name: process.env.PANEL_ADMIN_NAME || process.env.ADMIN_NAME || 'Administrador',
      email: String(process.env.PANEL_ADMIN_EMAIL || process.env.ADMIN_EMAIL || 'contato@personalizeseuambiente.com.br').toLowerCase(),
      password: panelAdminPassword || 'MudeEssaSenha123!',
    },
    demoMode,
    allowProduction,
    runtimeMode,
    panelTrustSecret: text(process.env.PANEL_INTERNAL_SECRET),
    demoApprovalDelayMs: number(process.env.DEMO_APPROVAL_DELAY_MS, 1800),
    focus: {
      environment,
      baseUrl: environment === 'producao' ? 'https://api.focusnfe.com.br' : 'https://homologacao.focusnfe.com.br',
      token: focusToken,
      timeoutMs: number(process.env.FOCUS_REQUEST_TIMEOUT_MS, 30000),
      documentTimeoutMs: number(process.env.FOCUS_DOCUMENT_TIMEOUT_MS, 60000),
      pollIntervalMs: Math.max(2000, number(process.env.FOCUS_POLL_INTERVAL_MS, 5000)),
      webhookSecret,
    },
    dpsSeries,
    company: {
      cnpj: String(process.env.COMPANY_CNPJ || '18342858000108').replace(/\D/g, ''),
      name: process.env.COMPANY_NAME || 'PERSONALIZE ADESIVOS DECORATIVOS LTDA',
      tradeName: process.env.COMPANY_TRADE_NAME || 'Personalize Seu Ambiente',
      municipalRegistration: String(process.env.COMPANY_MUNICIPAL_REGISTRATION || '04913840010').replace(/\D/g, ''),
      sendMunicipalRegistration: bool(process.env.COMPANY_SEND_MUNICIPAL_REGISTRATION, true),
      stateRegistration: String(process.env.COMPANY_STATE_REGISTRATION || '0021708330062').replace(/\D/g, ''),
      cityCode: String(process.env.COMPANY_CITY_CODE || '3106200'),
      city: process.env.COMPANY_CITY || 'Belo Horizonte',
      state: process.env.COMPANY_STATE || 'MG',
      simpleOption: String(process.env.COMPANY_SIMPLE_OPTION || '3'),
      simpleRegime: String(process.env.COMPANY_SIMPLE_REGIME || '1'),
      specialTaxRegime: String(process.env.COMPANY_SPECIAL_TAX_REGIME || '0'),
      approximateTaxPercent: number(process.env.COMPANY_APPROX_TAX_PERCENT, 8.5),
      timezoneOffset: timezoneOffset(process.env.COMPANY_TIMEZONE_OFFSET, '-03:00'),
    },
    services: {
      plotagem: {
        nbsCode: text(process.env.SERVICE_PLOTAGEM_NBS_CODE),
        ibsCbsTaxStatus: text(process.env.SERVICE_PLOTAGEM_IBS_CBS_TAX_STATUS),
        ibsCbsTaxClassification: text(process.env.SERVICE_PLOTAGEM_IBS_CBS_TAX_CLASSIFICATION),
      },
      producaoComunicacaoVisual: {
        nbsCode: text(process.env.SERVICE_PRODUCAO_NBS_CODE),
        ibsCbsTaxStatus: text(process.env.SERVICE_PRODUCAO_IBS_CBS_TAX_STATUS),
        ibsCbsTaxClassification: text(process.env.SERVICE_PRODUCAO_IBS_CBS_TAX_CLASSIFICATION),
      },
    },
    dataDirectory: path.resolve(root, process.env.FISCAL_DATA_DIRECTORY || './data/fiscal'),
    documentDirectory: path.resolve(root, process.env.FISCAL_DOCUMENT_DIRECTORY || './storage/fiscal-documents'),
    publicDirectory: path.resolve(root, './public/fiscal'),
  });
}

module.exports = { createConfig, loadDotEnv, bool, number, timezoneOffset };
