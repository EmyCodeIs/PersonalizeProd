'use strict';

const state = {
  leads: [],
  selectedId: null,
  token: localStorage.getItem('personalizeLeadToken') || '',
  user: localStorage.getItem('personalizeLeadUser') || '',
};

const elements = {};

function byId(id) {
  return document.getElementById(id);
}

function cacheElements() {
  for (const id of [
    'authPanel', 'tokenInput', 'userInput', 'saveTokenButton', 'notifyButton', 'refreshButton',
    'totalStat', 'pendingStat', 'contactedStat', 'discardedStat', 'alertStat', 'searchInput',
    'statusFilter', 'lastUpdated', 'feedback', 'emptyState', 'leadList', 'detailPanel',
    'detailPlaceholder', 'detailContent', 'detailStatus', 'detailName', 'detailContact',
    'detailService', 'detailCity', 'detailStage', 'detailIdle', 'detailLastMessage', 'detailAlert',
    'noteInput', 'downloadButton', 'transcriptCount', 'transcript', 'auditList',
  ]) elements[id] = byId(id);
}

function headers(extra = {}) {
  const result = { Accept: 'application/json', ...extra };
  if (state.token) result['x-admin-token'] = state.token;
  if (state.user) result['x-admin-user'] = state.user;
  return result;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: headers(options.headers || {}),
  });
  if (response.status === 401) {
    elements.authPanel.classList.remove('hidden');
    const error = new Error('Acesso protegido. Informe o token administrativo.');
    error.code = 'UNAUTHORIZED';
    throw error;
  }
  const payload = await response.json().catch(() => ({ ok: false, error: 'invalid_response' }));
  if (!response.ok || payload.ok === false) {
    const error = new Error(payload.message || payload.error || `HTTP ${response.status}`);
    error.code = payload.error || 'REQUEST_FAILED';
    throw error;
  }
  elements.authPanel.classList.add('hidden');
  return payload;
}

function showFeedback(message, error = false) {
  elements.feedback.textContent = message;
  elements.feedback.classList.toggle('error', error);
  elements.feedback.classList.remove('hidden');
  window.clearTimeout(showFeedback.timer);
  showFeedback.timer = window.setTimeout(() => elements.feedback.classList.add('hidden'), 4500);
}

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
}

function statusLabel(status) {
  return ({
    PENDING: 'Pendente',
    SEEN: 'Visto',
    CONTACTED: 'Contatado',
    DISCARDED: 'Descartado',
  })[status] || status || 'Pendente';
}

function setStatusBadge(element, status) {
  element.textContent = statusLabel(status);
  element.className = `status-badge status-${status || 'PENDING'}`;
}

function firstCustomerMessage(lead) {
  return lead.firstMessages?.[0]?.text
    || lead.transcript?.find((message) => message.actor === 'CLIENTE')?.text
    || 'Sem prévia de mensagem.';
}

function filteredLeads() {
  const query = elements.searchInput.value.trim().toLocaleLowerCase('pt-BR');
  const status = elements.statusFilter.value;
  return state.leads.filter((lead) => {
    if (status && lead.operationStatus !== status) return false;
    if (!query) return true;
    return [lead.customerName, lead.phone, lead.clientId, lead.city, lead.service, lead.stage]
      .filter(Boolean)
      .some((value) => String(value).toLocaleLowerCase('pt-BR').includes(query));
  });
}

function createLeadCard(lead) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `lead-card${state.selectedId === lead.operationId ? ' active' : ''}`;
  button.addEventListener('click', () => selectLead(lead.operationId));

  const head = document.createElement('div');
  head.className = 'lead-card-head';
  const identity = document.createElement('div');
  const title = document.createElement('h3');
  title.textContent = lead.customerName || 'Cliente não identificado';
  const contact = document.createElement('p');
  contact.textContent = lead.phone || lead.clientId || 'Contato indisponível';
  identity.append(title, contact);
  const badge = document.createElement('span');
  setStatusBadge(badge, lead.operationStatus);
  head.append(identity, badge);

  const meta = document.createElement('div');
  meta.className = 'lead-card-meta';
  for (const text of [
    `${lead.idleHours}h parado`,
    lead.service || 'Serviço não definido',
    lead.stage || 'Etapa desconhecida',
  ]) {
    const span = document.createElement('span');
    span.textContent = text;
    meta.appendChild(span);
  }

  const preview = document.createElement('p');
  preview.className = 'lead-card-preview';
  preview.textContent = firstCustomerMessage(lead).slice(0, 180);
  button.append(head, meta, preview);
  return button;
}

function renderList() {
  const leads = filteredLeads();
  elements.leadList.replaceChildren(...leads.map(createLeadCard));
  elements.emptyState.classList.toggle('hidden', leads.length > 0);
  if (state.selectedId && !state.leads.some((lead) => lead.operationId === state.selectedId)) {
    state.selectedId = null;
    renderDetail();
  }
}

function createMessage(message) {
  const item = document.createElement('article');
  item.className = `message ${message.actor === 'BOT' ? 'BOT' : 'CLIENTE'}`;
  const head = document.createElement('div');
  head.className = 'message-head';
  const actor = document.createElement('strong');
  actor.textContent = message.actor === 'BOT' ? 'Bot Personalize' : 'Cliente';
  const date = document.createElement('span');
  date.textContent = formatDate(message.at);
  head.append(actor, date);
  const text = document.createElement('p');
  text.textContent = message.text || '[sem texto]';
  item.append(head, text);
  return item;
}

function createAudit(item) {
  const row = document.createElement('div');
  row.className = 'audit-item';
  const title = document.createElement('strong');
  title.textContent = item.action || 'Ação registrada';
  const details = document.createElement('span');
  const transition = item.toStatus ? ` · ${statusLabel(item.toStatus)}` : '';
  details.textContent = `${formatDate(item.at)} · ${item.actor || 'sistema'}${transition}${item.note ? ` · ${item.note}` : ''}`;
  row.append(title, details);
  return row;
}

function selectedLead() {
  return state.leads.find((lead) => lead.operationId === state.selectedId) || null;
}

function renderDetail() {
  const lead = selectedLead();
  elements.detailPlaceholder.classList.toggle('hidden', Boolean(lead));
  elements.detailContent.classList.toggle('hidden', !lead);
  elements.detailPanel.classList.toggle('empty-detail', !lead);
  if (!lead) return;

  setStatusBadge(elements.detailStatus, lead.operationStatus);
  elements.detailName.textContent = lead.customerName || 'Cliente não identificado';
  elements.detailContact.textContent = lead.phone || lead.clientId || 'Contato indisponível';
  elements.detailService.textContent = lead.service || '—';
  elements.detailCity.textContent = lead.city || '—';
  elements.detailStage.textContent = lead.stage || '—';
  elements.detailIdle.textContent = `${lead.idleHours} hora(s)`;
  elements.detailLastMessage.textContent = formatDate(lead.lastCustomerMessageAt);
  elements.detailAlert.textContent = lead.notifiedAt
    ? `Enviado em ${formatDate(lead.notifiedAt)}`
    : (lead.alertStatus === 'PANEL_PENDING' ? 'Disponível no painel' : statusLabel(lead.alertStatus));
  elements.noteInput.value = lead.operationNote || '';
  elements.transcriptCount.textContent = `${lead.transcript?.length || 0} mensagem(ns)`;
  elements.transcript.replaceChildren(...(lead.transcript || []).map(createMessage));
  elements.auditList.replaceChildren(...[...(lead.audit || [])].reverse().map(createAudit));
  if (!(lead.audit || []).length) {
    const empty = document.createElement('p');
    empty.textContent = 'Nenhuma ação do vendedor registrada.';
    elements.auditList.appendChild(empty);
  }
}

function selectLead(id) {
  state.selectedId = id;
  renderList();
  renderDetail();
}

function updateStats(report) {
  elements.totalStat.textContent = report.total ?? 0;
  elements.pendingStat.textContent = report.pendingAction ?? 0;
  elements.contactedStat.textContent = report.contacted ?? 0;
  elements.discardedStat.textContent = report.discarded ?? 0;
  elements.alertStat.textContent = report.pendingNotification ?? 0;
  elements.lastUpdated.textContent = `Atualizado em ${formatDate(report.generatedAt)}`;
}

async function loadLeads() {
  elements.refreshButton.disabled = true;
  try {
    const payload = await api('/api/leads');
    state.leads = payload.report?.leads || [];
    updateStats(payload.report || {});
    renderList();
    renderDetail();
  } catch (error) {
    if (error.code !== 'UNAUTHORIZED') showFeedback(error.message, true);
  } finally {
    elements.refreshButton.disabled = false;
  }
}

async function updateAction(status) {
  const lead = selectedLead();
  if (!lead) return;
  const buttons = [...document.querySelectorAll('[data-action]')];
  buttons.forEach((button) => { button.disabled = true; });
  try {
    const payload = await api('/api/leads/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: lead.operationId,
        status,
        actor: state.user || 'vendedor',
        assignedTo: state.user || null,
        note: elements.noteInput.value.trim(),
      }),
    });
    Object.assign(lead, {
      operationStatus: payload.operation.status,
      operationNote: payload.operation.note,
      assignedTo: payload.operation.assignedTo,
      seenAt: payload.operation.seenAt,
      contactedAt: payload.operation.contactedAt,
      discardedAt: payload.operation.discardedAt,
      audit: payload.operation.audit || [],
    });
    showFeedback(`Lead marcado como ${statusLabel(status).toLowerCase()}.`);
    renderList();
    renderDetail();
    await loadLeads();
  } catch (error) {
    showFeedback(error.message, true);
  } finally {
    buttons.forEach((button) => { button.disabled = false; });
  }
}

async function downloadTranscript() {
  const lead = selectedLead();
  if (!lead) return;
  elements.downloadButton.disabled = true;
  try {
    const params = new URLSearchParams({
      conversationKey: lead.conversationKey,
      lastCustomerMessageAt: lead.lastCustomerMessageAt,
    });
    const response = await fetch(`/api/leads/transcript?${params}`, { headers: headers() });
    if (response.status === 401) {
      elements.authPanel.classList.remove('hidden');
      throw new Error('Acesso protegido. Informe o token administrativo.');
    }
    if (!response.ok) throw new Error('Não foi possível gerar o TXT deste lead.');
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `lead-${lead.phone || 'conversa'}.txt`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  } catch (error) {
    showFeedback(error.message, true);
  } finally {
    elements.downloadButton.disabled = false;
  }
}

async function notifyNow() {
  elements.notifyButton.disabled = true;
  try {
    const payload = await api('/api/leads/notify', { method: 'POST' });
    const result = payload.result || {};
    showFeedback(`Avisos: ${result.sent || 0} enviado(s), ${result.panelPending || 0} pendente(s) no painel, ${result.failed || 0} falha(s).`);
    await loadLeads();
  } catch (error) {
    showFeedback(error.message, true);
  } finally {
    elements.notifyButton.disabled = false;
  }
}

function saveAccess() {
  state.token = elements.tokenInput.value.trim();
  state.user = elements.userInput.value.trim();
  localStorage.setItem('personalizeLeadToken', state.token);
  localStorage.setItem('personalizeLeadUser', state.user);
  loadLeads();
}

function bindEvents() {
  elements.refreshButton.addEventListener('click', loadLeads);
  elements.notifyButton.addEventListener('click', notifyNow);
  elements.saveTokenButton.addEventListener('click', saveAccess);
  elements.searchInput.addEventListener('input', renderList);
  elements.statusFilter.addEventListener('change', renderList);
  elements.downloadButton.addEventListener('click', downloadTranscript);
  document.querySelectorAll('[data-action]').forEach((button) => {
    button.addEventListener('click', () => updateAction(button.dataset.action));
  });
  elements.tokenInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') saveAccess();
  });
}

window.addEventListener('DOMContentLoaded', () => {
  cacheElements();
  elements.tokenInput.value = state.token;
  elements.userInput.value = state.user;
  bindEvents();
  loadLeads();
});
