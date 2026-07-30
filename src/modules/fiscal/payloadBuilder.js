'use strict';

function digits(value) { return String(value || '').replace(/\D/g, ''); }
function text(value) { return String(value || '').trim(); }

function validateDraft(data) {
  const errors = [];
  const document = digits(data.clientDocument);
  if (![11, 14].includes(document.length)) errors.push('Informe um CPF ou CNPJ válido.');
  if (!text(data.clientName)) errors.push('Informe o nome ou razão social do cliente.');
  if (!/^\d{8}$/.test(digits(data.clientPostalCode))) errors.push('Informe um CEP com 8 dígitos.');
  if (!text(data.clientStreet)) errors.push('Informe o logradouro do cliente.');
  if (!text(data.clientNumber)) errors.push('Informe o número do endereço.');
  if (!text(data.clientNeighborhood)) errors.push('Informe o bairro do cliente.');
  if (!/^\d{7}$/.test(digits(data.clientCityCode))) errors.push('Informe o código IBGE do município do cliente.');
  if (!text(data.clientCity)) errors.push('Informe o município do cliente.');
  if (!/^[A-Za-z]{2}$/.test(text(data.clientState))) errors.push('Informe a UF do cliente.');
  if (!text(data.serviceProfileId)) errors.push('Escolha um tipo de serviço.');
  if (!/^\d{7}$/.test(digits(data.serviceCityCode))) errors.push('Informe o código IBGE do local da prestação.');
  if (!text(data.serviceCity)) errors.push('Informe o município da prestação.');
  if (!/^[A-Za-z]{2}$/.test(text(data.serviceState))) errors.push('Informe a UF da prestação.');
  if (text(data.serviceDescription).length < 5) errors.push('Descreva o serviço prestado.');
  const amount = Number(data.serviceAmount);
  if (!Number.isFinite(amount) || amount <= 0) errors.push('Informe um valor de serviço maior que zero.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text(data.competenceDate))) errors.push('Informe a data de competência.');
  return errors;
}

function formatFocusDateTime(date = new Date(), timezoneOffset = '-03:00') {
  const match = String(timezoneOffset).match(/^([+-])(\d{2}):(\d{2})$/);
  if (!match) throw new Error('Fuso de emissão inválido. Use o formato -03:00.');
  const direction = match[1] === '+' ? 1 : -1;
  const offsetMinutes = direction * (Number(match[2]) * 60 + Number(match[3]));
  const shifted = new Date(date.getTime() + offsetMinutes * 60_000);
  return `${shifted.toISOString().slice(0, 19)}${timezoneOffset}`;
}

function buildPayload({ data, service, company, dpsSeries, dpsNumber, emittedAt = new Date() }) {
  const document = digits(data.clientDocument);
  const ibsCbsStatus = text(service.ibs_cbs_tax_status);
  const ibsCbsClassification = text(service.ibs_cbs_tax_classification);
  if (Boolean(ibsCbsStatus) !== Boolean(ibsCbsClassification)) {
    throw new Error('A configuração IBS/CBS do serviço está incompleta. Informe situação e classificação tributária juntas.');
  }
  const payload = {
    data_emissao: formatFocusDateTime(emittedAt, company.timezoneOffset || '-03:00'),
    serie_dps: Number(dpsSeries),
    numero_dps: Number(dpsNumber),
    data_competencia: text(data.competenceDate),
    emitente_dps: '1',
    codigo_municipio_emissora: Number(company.cityCode),
    cnpj_prestador: company.cnpj,
    inscricao_municipal_prestador: company.sendMunicipalRegistration ? company.municipalRegistration : undefined,
    codigo_opcao_simples_nacional: company.simpleOption,
    regime_tributario_simples_nacional: company.simpleRegime,
    regime_especial_tributacao: company.specialTaxRegime,
    razao_social_tomador: text(data.clientName),
    email_tomador: text(data.clientEmail) || undefined,
    codigo_municipio_tomador: digits(data.clientCityCode),
    cep_tomador: digits(data.clientPostalCode),
    logradouro_tomador: text(data.clientStreet),
    numero_tomador: text(data.clientNumber),
    complemento_tomador: text(data.clientComplement) || undefined,
    bairro_tomador: text(data.clientNeighborhood),
    codigo_municipio_prestacao: digits(data.serviceCityCode),
    codigo_tributacao_nacional_iss: service.national_tax_code,
    codigo_tributacao_municipal_iss: service.municipal_tax_code || undefined,
    codigo_nbs: service.nbs_code || undefined,
    ibs_cbs_situacao_tributaria: ibsCbsStatus || undefined,
    ibs_cbs_classificacao_tributaria: ibsCbsClassification || undefined,
    descricao_servico: text(data.serviceDescription),
    valor_servico: Number(Number(data.serviceAmount).toFixed(2)),
    tributacao_iss: Number(service.iss_taxation),
    tipo_retencao_iss: Number(service.iss_retention_type),
    situacao_tributaria_pis_cofins: service.pis_cofins_status,
    percentual_total_tributos_simples_nacional: Number(service.approximate_tax_percent),
  };
  if (document.length === 14) payload.cnpj_tomador = document;
  else payload.cpf_tomador = document;
  return Object.fromEntries(Object.entries(payload).filter(([, value]) => value !== undefined && value !== ''));
}

module.exports = { validateDraft, buildPayload, formatFocusDateTime, digits };
