'use strict';

const fs = require('node:fs');
const path = require('node:path');

function nestedObjects(response = {}) {
  const candidates = [response];
  for (const key of ['data', 'documento', 'nfse', 'nfsen', 'nota', 'resultado']) {
    if (response && typeof response[key] === 'object' && response[key] !== null) candidates.push(response[key]);
  }
  return candidates;
}

function firstValue(response, keys) {
  for (const candidate of nestedObjects(response)) {
    for (const key of keys) {
      const value = candidate?.[key];
      if (value !== undefined && value !== null && String(value).trim() !== '') return value;
    }
  }
  return null;
}

function mapStatus(response = {}) {
  const raw = String(firstValue(response, ['status', 'status_sefaz', 'situacao', 'situacao_nfse']) || '').toLowerCase();
  if (raw.includes('process') || raw.includes('fila') || raw.includes('pendente') || raw.includes('aguard')) return 'processing';
  if (raw.includes('erro') || raw.includes('rejeit') || raw.includes('negad') || raw.includes('falha')) return 'error';
  if (raw.includes('cancel')) return 'cancelled';
  if (raw.includes('autoriz') || raw.includes('sucesso')) return 'authorized';
  return 'processing';
}

function extractErrorMessage(payload = {}, fallback = 'A Focus não conseguiu processar a solicitação.') {
  const direct = firstValue(payload, ['mensagem_sefaz', 'mensagem', 'message', 'erro', 'error', 'motivo', 'descricao']);
  if (direct) return String(direct);
  const collections = [payload.erros, payload.errors, payload.mensagens];
  for (const collection of collections) {
    if (!Array.isArray(collection) || !collection.length) continue;
    const messages = collection.map((item) => {
      if (typeof item === 'string') return item;
      return item?.mensagem || item?.message || item?.erro || item?.descricao || JSON.stringify(item);
    }).filter(Boolean);
    if (messages.length) return messages.join(' | ');
  }
  return fallback;
}

function extractFiscalMetadata(response = {}) {
  return {
    number: firstValue(response, ['numero', 'numero_nfse', 'numero_nfs_e', 'nNFSe']),
    fiscalKey: firstValue(response, ['chave', 'chave_nfse', 'chave_nfsen', 'chave_acesso', 'chaveAcesso']),
    verificationCode: firstValue(response, ['codigo_verificacao', 'codigoVerificacao', 'cod_verificacao']),
  };
}

function extractDocumentLinks(response = {}) {
  return {
    pdf: firstValue(response, [
      'caminho_danfse', 'caminho_pdf', 'url_danfse', 'url_pdf', 'pdf_url', 'link_pdf', 'danfse_pdf',
    ]),
    xml: firstValue(response, [
      'caminho_xml_nota_fiscal', 'caminho_xml', 'url_xml', 'xml_url', 'link_xml',
    ]),
  };
}

class FocusClient {
  constructor(config) {
    this.config = config;
  }

  #headers(contentType = true) {
    if (!this.config.focus.token) throw Object.assign(new Error('Token da Focus não configurado para o ambiente selecionado.'), { code: 'FOCUS_TOKEN_MISSING' });
    return {
      Authorization: `Basic ${Buffer.from(`${this.config.focus.token}:`).toString('base64')}`,
      Accept: 'application/json',
      ...(contentType ? { 'Content-Type': 'application/json' } : {}),
    };
  }

  async #request(method, endpoint, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.focus.timeoutMs);
    try {
      const response = await fetch(`${this.config.focus.baseUrl}${endpoint}`, {
        method,
        headers: this.#headers(body !== undefined),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await response.text();
      let payload;
      try { payload = text ? JSON.parse(text) : {}; } catch { payload = { raw: text }; }
      if (!response.ok) {
        const error = new Error(extractErrorMessage(payload, `Focus respondeu HTTP ${response.status}.`));
        error.code = `FOCUS_HTTP_${response.status}`;
        error.status = response.status;
        error.response = payload;
        throw error;
      }
      return payload;
    } catch (error) {
      if (error?.name === 'AbortError') {
        const timeoutError = new Error('A Focus demorou mais que o limite configurado para responder.');
        timeoutError.code = 'FOCUS_TIMEOUT';
        timeoutError.status = 504;
        throw timeoutError;
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async issue(reference, payload) {
    if (this.config.demoMode) return { status: 'processando_autorizacao', referencia: reference, demo: true, receivedAt: Date.now() };
    return this.#request('POST', `/v2/nfsen?ref=${encodeURIComponent(reference)}`, payload);
  }

  async consult(reference, context = {}) {
    if (this.config.demoMode) {
      const elapsed = Date.now() - new Date(context.issuedAt || context.createdAt || 0).getTime();
      if (elapsed < this.config.demoApprovalDelayMs) return { status: 'processando_autorizacao', referencia: reference, demo: true };
      return { status: 'autorizado', referencia: reference, numero: `D${String(context.id || 1).padStart(6, '0')}`, demo: true };
    }
    return this.#request('GET', `/v2/nfsen/${encodeURIComponent(reference)}`);
  }

  async cancel(reference, justification) {
    if (this.config.demoMode) return { status: 'cancelado', referencia: reference, justificativa: justification, demo: true };
    return this.#request('DELETE', `/v2/nfsen/${encodeURIComponent(reference)}`, { justificativa: justification });
  }

  async resendWebhook(reference) {
    if (this.config.demoMode) return [];
    return this.#request('POST', `/v2/nfsen/${encodeURIComponent(reference)}/hook`);
  }

  async lookupCnpj(cnpj) {
    if (this.config.demoMode) {
      const clean = String(cnpj).replace(/\D/g, '');
      const samples = {
        '12603835000115': { cnpj: clean, razao_social: 'FELICITA ODONTOLOGIA LTDA', cep: '30840460', logradouro: 'ROMUALDO LOPES CANCADO', numero: '125', complemento: 'LOJA 206', bairro: 'CASTELO', municipio: 'Belo Horizonte', uf: 'MG', codigo_municipio: '3106200' },
        '18970642000189': { cnpj: clean, razao_social: 'TOTAL FIT ACADEMIA DE GINASTICA LTDA', cep: '23860000', logradouro: 'SAO JOAO MARCOS', numero: '81', complemento: 'QUADRA GL; LOTE 29', bairro: 'EL RANCHITO', municipio: 'Mangaratiba', uf: 'RJ', codigo_municipio: '3302601' },
      };
      return samples[clean] || { cnpj: clean };
    }
    return this.#request('GET', `/v2/cnpjs/${String(cnpj).replace(/\D/g, '')}`);
  }

  async lookupCep(cep) {
    if (this.config.demoMode) return { cep: String(cep).replace(/\D/g, '') };
    return this.#request('GET', `/v2/ceps/${String(cep).replace(/\D/g, '')}`);
  }

  async download(remotePath, targetPath) {
    if (!remotePath) throw new Error('A Focus não informou o endereço do documento.');
    const absolute = /^https?:\/\//i.test(remotePath);
    const url = absolute
      ? remotePath
      : `${this.config.focus.baseUrl}${remotePath.startsWith('/') ? '' : '/'}${remotePath}`;
    const remoteHost = new URL(url).host;
    const focusHost = new URL(this.config.focus.baseUrl).host;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.focus.documentTimeoutMs);
    try {
      const response = await fetch(url, {
        headers: remoteHost === focusHost ? this.#headers(false) : { Accept: '*/*' },
        redirect: 'follow',
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Falha ao baixar documento da Focus (HTTP ${response.status}).`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (!bytes.length) throw new Error('A Focus devolveu um documento vazio.');
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, bytes);
      return targetPath;
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error('O download do documento fiscal excedeu o tempo limite.');
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

module.exports = {
  FocusClient,
  mapStatus,
  extractErrorMessage,
  extractFiscalMetadata,
  extractDocumentLinks,
};
