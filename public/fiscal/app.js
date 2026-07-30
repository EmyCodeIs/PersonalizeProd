'use strict';

if (window.self !== window.top || new URLSearchParams(window.location.search).get('embedded') === '1') {
  document.documentElement.classList.add('fiscal-embedded');
}

const app = document.querySelector('#app');
const toast = document.querySelector('#toast');
const state = { user: null, demoMode: true, environment: 'homologacao', runtimeMode: 'demonstracao', allowProduction: false, pollIntervalMs: 5000, services: [] };

const money = (value) => Number(value || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const dateTime = (value) => value ? new Date(value).toLocaleString('pt-BR') : '—';
const digits = (value) => String(value || '').replace(/\D/g, '');
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const statusLabel = { authorized: 'Autorizada', processing: 'Processando', sending: 'Enviando', error: 'Com erro', cancelled: 'Cancelada', draft: 'Rascunho' };
const environmentLabel = () => state.demoMode ? 'Demonstração' : (state.environment === 'producao' ? 'PRODUÇÃO REAL' : 'Homologação real');

async function api(url, options = {}) {
  const response = await fetch(url, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const type = response.headers.get('content-type') || '';
  const payload = type.includes('application/json') ? await response.json() : await response.text();
  if (!response.ok) {
    const error = new Error(payload.error || 'Não foi possível concluir a operação.');
    error.payload = payload;
    error.status = response.status;
    throw error;
  }
  return payload;
}

function notify(message, type = '') {
  toast.textContent = message;
  toast.className = `toast show ${type}`;
  clearTimeout(notify.timer);
  notify.timer = setTimeout(() => { toast.className = 'toast'; }, 3500);
}

function icon(name) {
  const icons = { home: '⌂', new: '+', notes: '▤', drafts: '◇', logout: '↪' };
  return `<span class="icon">${icons[name] || '•'}</span>`;
}

function shell(content, title) {
  const route = location.hash || '#/';
  const link = (hash, label, name) => `<a class="nav-link ${route === hash ? 'active' : ''}" href="${hash}">${icon(name)}${label}</a>`;
  return `<div class="app-shell">
    <aside class="sidebar"><div class="brand"><div class="brand-mark">P</div><div>Personalize NF</div></div>
      <nav class="sidebar-nav">${link('#/','Início','home')}${link('#/nova','Nova NFS-e','new')}${link('#/notas','Notas fiscais','notes')}${link('#/rascunhos','Rascunhos','drafts')}</nav>
      <div class="sidebar-footer"><div class="user-chip"><div class="avatar">${escapeHtml(state.user.name[0])}</div><div><strong>${escapeHtml(state.user.name)}</strong><small>${state.user.role === 'admin' ? 'Administrador' : 'Vendedor'}</small></div></div><button class="nav-link" data-action="logout">${icon('logout')}Sair</button></div>
    </aside>
    <main class="main"><header class="topbar"><h1>${escapeHtml(title)}</h1><div class="environment-badge">${escapeHtml(environmentLabel())}</div></header><div class="content">${content}</div></main>
    <nav class="mobile-nav"><a class="${route === '#/' ? 'active' : ''}" href="#/">Início</a><a class="${route === '#/nova' ? 'active' : ''}" href="#/nova">Nova</a><a class="${route === '#/notas' ? 'active' : ''}" href="#/notas">Notas</a><a class="${route === '#/rascunhos' ? 'active' : ''}" href="#/rascunhos">Rascunhos</a></nav>
  </div>`;
}

function loginView() {
  app.innerHTML = `<div class="login-shell"><section class="login-visual"><div class="brand"><div class="brand-mark">P</div>Personalize NF</div><div class="login-copy"><h1>Notas fiscais sem complicação.</h1><p>Emita, acompanhe e organize as NFS-e da Personalize em um painel simples, seguro e feito para o dia a dia dos vendedores.</p><div class="login-benefits"><div class="login-benefit"><span>✓</span>Formulário visual e conferência antes da emissão</div><div class="login-benefit"><span>✓</span>Histórico completo, PDF e XML em um só lugar</div><div class="login-benefit"><span>✓</span>Códigos fiscais protegidos e preenchidos automaticamente</div></div></div><small>Personalize Seu Ambiente</small></section><section class="login-form-wrap"><form class="login-card" id="login-form"><h2>Bem-vinda</h2><p>Entre com sua conta para acessar o painel fiscal.</p><div class="field"><label>E-mail</label><input name="email" type="email" value="contato@personalizeseuambiente.com.br" autocomplete="username" required></div><div class="field"><label>Senha</label><input name="password" type="password" autocomplete="current-password" required></div><button class="button primary full">Entrar no painel</button><div class="demo-note">O ambiente ativo será identificado no painel após o login.</div></form></section></div>`;
  document.querySelector('#login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.currentTarget));
    try {
      const result = await api('/fiscal/api/auth/login', { method: 'POST', body: JSON.stringify(data) });
      state.user = result.user;
      location.hash = '#/';
      await route();
    } catch (error) { notify(error.message, 'error'); }
  });
}

async function dashboardView() {
  const data = await api('/fiscal/api/dashboard');
  const count = (name) => data.counts[name] || 0;
  const rows = data.recent.map((item) => `<tr data-invoice="${item.id}"><td><strong>${escapeHtml(item.nfse_number || item.focus_reference.slice(-8))}</strong><br><small>${dateTime(item.created_at)}</small></td><td>${escapeHtml(item.client_name)}</td><td>${escapeHtml(item.service_name)}</td><td>${money(item.service_amount)}</td><td><span class="status ${item.status}">${statusLabel[item.status] || item.status}</span></td></tr>`).join('');
  app.innerHTML = shell(`<div class="hero-row"><div><h2>Olá, ${escapeHtml(state.user.name)} 👋</h2><p>Acompanhe as emissões da equipe e crie uma nova NFS-e.</p></div><a class="button primary" href="#/nova">+ Nova NFS-e</a></div><section class="metrics"><div class="metric"><div class="metric-label">Autorizadas</div><div class="metric-value">${count('authorized')}</div><div class="metric-foot">Notas concluídas</div></div><div class="metric"><div class="metric-label">Processando</div><div class="metric-value">${count('processing') + count('sending')}</div><div class="metric-foot">Aguardando retorno</div></div><div class="metric"><div class="metric-label">Com erro</div><div class="metric-value">${count('error')}</div><div class="metric-foot">Precisam de atenção</div></div><div class="metric"><div class="metric-label">Rascunhos</div><div class="metric-value">${data.drafts}</div><div class="metric-foot">Ainda não emitidos</div></div></section><section class="card"><div class="card-header"><h3>Notas recentes</h3><a class="button ghost" href="#/notas">Ver todas</a></div>${rows ? `<div class="table-wrap"><table class="table"><thead><tr><th>Número</th><th>Cliente</th><th>Serviço</th><th>Valor</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<div class="empty">Nenhuma nota emitida ainda.</div>'}</section>`, 'Início');
  bindCommon();
  document.querySelectorAll('[data-invoice]').forEach((row) => row.addEventListener('click', () => { location.hash = `#/notas/${row.dataset.invoice}`; }));
}

function defaultForm() {
  return {
    clientDocument:'', clientName:'', clientEmail:'', clientPostalCode:'', clientStreet:'', clientNumber:'',
    clientComplement:'', clientNeighborhood:'', clientCityCode:'', clientCity:'', clientState:'MG',
    serviceProfileId:'', serviceCityCode:'3106200', serviceCity:'Belo Horizonte', serviceState:'MG',
    serviceDescription:'', serviceAmount:'', competenceDate:new Date().toISOString().slice(0,10),
  };
}

async function newInvoiceView(initialDraftId = null) {
  if (!state.services.length) state.services = (await api('/fiscal/api/services')).items;
  let draftId = initialDraftId;
  let form = defaultForm();
  if (draftId) form = (await api(`/fiscal/api/drafts/${draftId}`)).data;
  const services = state.services.map((service) => `<button type="button" class="service-option ${form.serviceProfileId === service.id ? 'selected' : ''}" data-service="${service.id}"><strong>${escapeHtml(service.name)}</strong><small>${escapeHtml(service.description_template)}</small></button>`).join('');
  app.innerHTML = shell(`<div class="hero-row"><div><h2>${draftId ? 'Editar rascunho' : 'Nova NFS-e'}</h2><p>Preencha os dados e confira tudo antes de emitir.</p></div></div><form class="form-card" id="invoice-form"><div class="progress"><div class="progress-step active">1. Cliente</div><div class="progress-step active">2. Serviço</div><div class="progress-step active">3. Prestação</div><div class="progress-step active">4. Conferência</div></div><section class="form-section"><h3>Dados do cliente</h3><p>Use CPF ou CNPJ do tomador do serviço.</p><div class="form-grid"><div class="field"><label>CPF ou CNPJ</label><div style="display:flex;gap:8px"><input name="clientDocument" value="${escapeHtml(form.clientDocument)}" required><button class="button secondary" type="button" data-action="lookup-cnpj">Buscar</button></div></div><div class="field"><label>Nome ou razão social</label><input name="clientName" value="${escapeHtml(form.clientName)}" required></div><div class="field"><label>E-mail opcional</label><input name="clientEmail" type="email" value="${escapeHtml(form.clientEmail)}"></div><div class="field"><label>CEP</label><input name="clientPostalCode" value="${escapeHtml(form.clientPostalCode)}" required></div><div class="field"><label>Logradouro</label><input name="clientStreet" value="${escapeHtml(form.clientStreet)}" required></div><div class="field"><label>Número</label><input name="clientNumber" value="${escapeHtml(form.clientNumber)}" required></div><div class="field"><label>Complemento</label><input name="clientComplement" value="${escapeHtml(form.clientComplement)}"></div><div class="field"><label>Bairro</label><input name="clientNeighborhood" value="${escapeHtml(form.clientNeighborhood)}" required></div><div class="field"><label>Município</label><input name="clientCity" value="${escapeHtml(form.clientCity)}" required></div><div class="field"><label>UF</label><input name="clientState" maxlength="2" value="${escapeHtml(form.clientState)}" required></div><div class="field span-2"><label>Código IBGE do município</label><input name="clientCityCode" value="${escapeHtml(form.clientCityCode)}" required></div></div></section><section class="form-section"><h3>Tipo de serviço</h3><p>Os códigos fiscais são preenchidos automaticamente pelo sistema.</p><div class="service-grid">${services}</div><input type="hidden" name="serviceProfileId" value="${escapeHtml(form.serviceProfileId)}"></section><section class="form-section"><h3>Informações da prestação</h3><p>Informe onde o serviço foi realizado e o que deve aparecer na nota.</p><div class="form-grid"><div class="field"><label>Município da prestação</label><input name="serviceCity" value="${escapeHtml(form.serviceCity)}" required></div><div class="field"><label>UF</label><input name="serviceState" maxlength="2" value="${escapeHtml(form.serviceState)}" required></div><div class="field span-2"><label>Código IBGE do local da prestação</label><input name="serviceCityCode" value="${escapeHtml(form.serviceCityCode)}" required></div><div class="field span-2"><label>Descrição do serviço</label><textarea name="serviceDescription" required>${escapeHtml(form.serviceDescription)}</textarea></div><div class="field"><label>Valor do serviço</label><input name="serviceAmount" type="number" min="0.01" step="0.01" value="${escapeHtml(form.serviceAmount)}" required></div><div class="field"><label>Data de competência</label><input name="competenceDate" type="date" value="${escapeHtml(form.competenceDate)}" required></div></div></section><div class="form-actions"><a class="button secondary" href="#/">Cancelar</a><button class="button secondary" type="button" data-action="save-draft">Salvar rascunho</button><button class="button primary" type="submit">Conferir e emitir</button></div></form>`, draftId ? 'Editar rascunho' : 'Nova NFS-e');
  bindCommon();
  const formEl = document.querySelector('#invoice-form');
  document.querySelectorAll('[data-service]').forEach((button) => button.addEventListener('click', () => {
    document.querySelectorAll('[data-service]').forEach((item) => item.classList.remove('selected'));
    button.classList.add('selected');
    formEl.elements.serviceProfileId.value = button.dataset.service;
    const service = state.services.find((item) => item.id === button.dataset.service);
    if (!formEl.elements.serviceDescription.value.trim()) formEl.elements.serviceDescription.value = service.description_template;
  }));
  document.querySelector('[data-action="lookup-cnpj"]').addEventListener('click', async () => {
    const document = digits(formEl.elements.clientDocument.value);
    if (document.length !== 14) return notify('A busca automática está disponível para CNPJ.', 'error');
    try {
      const data = await api(`/fiscal/api/lookup/cnpj/${document}`);
      const set = (name, value) => { if (value !== undefined && value !== null) formEl.elements[name].value = value; };
      set('clientName', data.razao_social || data.nome || data.nome_fantasia);
      set('clientPostalCode', data.cep);
      set('clientStreet', data.logradouro);
      set('clientNumber', data.numero);
      set('clientComplement', data.complemento);
      set('clientNeighborhood', data.bairro);
      set('clientCity', data.municipio);
      set('clientState', data.uf);
      set('clientCityCode', data.codigo_municipio);
      notify('Dados encontrados. Confira antes de continuar.');
    } catch (error) { notify(error.message, 'error'); }
  });
  function collect() { return Object.fromEntries(new FormData(formEl)); }
  async function save() {
    const body = collect();
    if (draftId) {
      await api(`/fiscal/api/drafts/${draftId}`, { method: 'PUT', body: JSON.stringify(body) });
      return draftId;
    }
    const result = await api('/fiscal/api/drafts', { method: 'POST', body: JSON.stringify(body) });
    draftId = result.id;
    return draftId;
  }
  document.querySelector('[data-action="save-draft"]').addEventListener('click', async () => {
    try { await save(); notify('Rascunho salvo.'); location.hash = '#/rascunhos'; }
    catch (error) { notify(error.message, 'error'); }
  });
  formEl.addEventListener('submit', async (event) => {
    event.preventDefault();
    const body = collect();
    const service = state.services.find((item) => item.id === body.serviceProfileId);
    if (!service) return notify('Escolha um tipo de serviço.', 'error');
    const confirmed = confirm(`CONFIRA ANTES DE EMITIR\n\nAmbiente: ${environmentLabel()}\nCliente: ${body.clientName}\nDocumento: ${body.clientDocument}\nServiço: ${service.name}\nDescrição: ${body.serviceDescription}\nValor: ${money(body.serviceAmount)}\n\nDeseja emitir esta NFS-e?`);
    if (!confirmed) return;
    if (!state.demoMode && state.environment === 'producao') {
      const typed = prompt('ATENÇÃO: esta emissão terá validade fiscal. Digite EMITIR para confirmar:');
      if (typed !== 'EMITIR') return notify('Emissão em produção cancelada.', 'error');
    }
    try {
      const id = await save();
      const result = await api(`/fiscal/api/drafts/${id}/issue`, { method: 'POST', body: '{}' });
      notify('NFS-e enviada para processamento.');
      location.hash = `#/notas/${result.invoice.id}`;
    } catch (error) {
      notify(error.payload?.fields?.join(' ') || error.message, 'error');
    }
  });
}

async function invoicesView() {
  app.innerHTML = shell(`<div class="hero-row"><div><h2>Notas fiscais</h2><p>Consulte todas as emissões e acompanhe o status.</p></div><a class="button primary" href="#/nova">+ Nova NFS-e</a></div><section class="card"><div class="filters"><input class="search" id="search" placeholder="Buscar cliente, documento, número ou referência"><select id="status-filter"><option value="">Todos os status</option><option value="authorized">Autorizadas</option><option value="processing">Processando</option><option value="error">Com erro</option><option value="cancelled">Canceladas</option></select></div><div id="invoice-list"></div></section>`, 'Notas fiscais');
  bindCommon();
  let timer;
  async function load() {
    const search = document.querySelector('#search').value;
    const status = document.querySelector('#status-filter').value;
    const data = await api(`/fiscal/api/invoices?search=${encodeURIComponent(search)}&status=${encodeURIComponent(status)}`);
    const rows = data.items.map((item) => `<tr data-invoice="${item.id}"><td><strong>${escapeHtml(item.nfse_number || 'Aguardando')}</strong><br><small>${escapeHtml(item.focus_reference)}</small></td><td>${escapeHtml(item.client_name)}<br><small>${escapeHtml(item.client_document)}</small></td><td>${escapeHtml(item.service_name)}</td><td>${money(item.service_amount)}</td><td><span class="status ${item.status}">${statusLabel[item.status] || item.status}</span></td><td>${dateTime(item.created_at)}</td></tr>`).join('');
    document.querySelector('#invoice-list').innerHTML = rows ? `<div class="table-wrap"><table class="table"><thead><tr><th>NFS-e</th><th>Cliente</th><th>Serviço</th><th>Valor</th><th>Status</th><th>Criada em</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<div class="empty">Nenhuma nota encontrada.</div>';
    document.querySelectorAll('[data-invoice]').forEach((row) => row.addEventListener('click', () => { location.hash = `#/notas/${row.dataset.invoice}`; }));
  }
  document.querySelector('#search').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(load, 250); });
  document.querySelector('#status-filter').addEventListener('change', load);
  await load();
}

async function invoiceDetailView(id) {
  const data = await api(`/fiscal/api/invoices/${id}`);
  const item = data.invoice;
  const actions = [`<a class="button secondary" href="#/notas">Voltar</a>`];
  if (item.hasPdf) actions.push(`<a class="button secondary" href="/fiscal/api/invoices/${id}/pdf">Baixar PDF</a>`);
  if (item.hasXml) actions.push(`<a class="button secondary" href="/fiscal/api/invoices/${id}/xml">Baixar XML</a>`);
  actions.push(`<button class="button secondary" data-action="duplicate">Duplicar</button>`);
  if (item.status === 'processing' || item.status === 'sending' || item.documentsPending) actions.push(`<button class="button primary" data-action="refresh">${item.documentsPending ? 'Atualizar documentos' : 'Atualizar situação'}</button>`);
  if (item.status === 'authorized' && state.user.role === 'admin') actions.push(`<button class="button danger" data-action="cancel">Cancelar NFS-e</button>`);
  const history = item.events.map((event) => `<div class="timeline-item"><div class="timeline-dot"></div><div><strong>${escapeHtml(event.message)}</strong><small>${dateTime(event.created_at)}</small></div></div>`).join('');
  app.innerHTML = shell(`<div class="hero-row"><div><div class="detail-title"><h2>${escapeHtml(item.nfse_number ? `NFS-e ${item.nfse_number}` : 'Emissão em andamento')}</h2><span class="status ${item.status}">${statusLabel[item.status] || item.status}</span></div><p>Referência ${escapeHtml(item.focus_reference)}</p></div></div>${item.error_message ? `<div class="card" style="background:var(--red-bg);color:var(--red);margin-bottom:18px"><strong>Erro da emissão</strong><p>${escapeHtml(item.error_message)}</p></div>` : ''}${item.document_error ? `<div class="card" style="margin-bottom:18px"><strong>Documento ainda não baixado</strong><p>${escapeHtml(item.document_error)}</p></div>` : ''}<div class="detail-grid"><section class="card"><div class="card-header"><h3>Dados da nota</h3></div><div class="detail-list"><div><small>Cliente</small><strong>${escapeHtml(item.client_name)}</strong></div><div><small>Documento</small><strong>${escapeHtml(item.client_document)}</strong></div><div><small>Serviço</small><strong>${escapeHtml(item.service_name)}</strong></div><div><small>Valor</small><strong>${money(item.service_amount)}</strong></div><div><small>Ambiente</small><strong>${escapeHtml(item.runtime_mode === 'demonstracao' ? 'Demonstração' : item.environment === 'producao' ? 'Produção real' : 'Homologação real')}</strong></div><div><small>Emitida por</small><strong>${escapeHtml(item.owner_name)}</strong></div><div><small>Criada em</small><strong>${dateTime(item.created_at)}</strong></div>${item.fiscal_key ? `<div class="span-2"><small>Chave fiscal</small><strong>${escapeHtml(item.fiscal_key)}</strong></div>` : ''}</div><div style="margin-top:18px"><small style="color:var(--muted)">Descrição</small><p>${escapeHtml(item.service_description)}</p></div><div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:24px">${actions.join('')}</div></section><aside class="card"><div class="card-header"><h3>Histórico</h3></div><div class="timeline">${history}</div></aside></div>`, 'Detalhes da NFS-e');
  bindCommon();
  document.querySelector('[data-action="refresh"]')?.addEventListener('click', async () => {
    try { await api(`/fiscal/api/invoices/${id}/refresh`, { method: 'POST', body: '{}' }); await invoiceDetailView(id); }
    catch (error) { notify(error.message, 'error'); }
  });
  document.querySelector('[data-action="duplicate"]')?.addEventListener('click', async () => {
    try { const result = await api(`/fiscal/api/invoices/${id}/duplicate`, { method: 'POST', body: '{}' }); location.hash = `#/rascunhos/${result.id}`; }
    catch (error) { notify(error.message, 'error'); }
  });
  document.querySelector('[data-action="cancel"]')?.addEventListener('click', async () => {
    const justification = prompt('Informe a justificativa do cancelamento (mínimo 15 caracteres):');
    if (!justification) return;
    try {
      await api(`/fiscal/api/invoices/${id}/cancel`, { method: 'POST', body: JSON.stringify({ justification }) });
      notify('NFS-e cancelada.');
      await invoiceDetailView(id);
    } catch (error) { notify(error.message, 'error'); }
  });
  if (item.status === 'processing' || item.status === 'sending' || item.documentsPending) setTimeout(() => { if (location.hash === `#/notas/${id}`) invoiceDetailView(id); }, Math.max(2200, state.pollIntervalMs || 5000));
}

async function draftsView() {
  if (!state.services.length) state.services = (await api('/fiscal/api/services')).items;
  const data = await api('/fiscal/api/drafts');
  const rows = data.items.filter((item) => item.status === 'draft').map((item) => `<tr data-draft="${item.id}"><td><strong>${escapeHtml(item.data.clientName || 'Sem cliente')}</strong><br><small>${escapeHtml(item.data.clientDocument || '')}</small></td><td>${escapeHtml(state.services.find((service) => service.id === item.data.serviceProfileId)?.name || 'Serviço não escolhido')}</td><td>${money(item.data.serviceAmount)}</td><td>${dateTime(item.updated_at)}</td><td><button class="button secondary" data-delete="${item.id}">Excluir</button></td></tr>`).join('');
  app.innerHTML = shell(`<div class="hero-row"><div><h2>Rascunhos</h2><p>Continue notas que ainda não foram enviadas.</p></div><a class="button primary" href="#/nova">+ Novo rascunho</a></div><section class="card">${rows ? `<div class="table-wrap"><table class="table"><thead><tr><th>Cliente</th><th>Serviço</th><th>Valor</th><th>Atualizado em</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` : '<div class="empty">Nenhum rascunho salvo.</div>'}</section>`, 'Rascunhos');
  bindCommon();
  document.querySelectorAll('[data-draft]').forEach((row) => row.addEventListener('click', (event) => {
    if (!event.target.closest('[data-delete]')) location.hash = `#/rascunhos/${row.dataset.draft}`;
  }));
  document.querySelectorAll('[data-delete]').forEach((button) => button.addEventListener('click', async () => {
    if (!confirm('Excluir este rascunho?')) return;
    await api(`/fiscal/api/drafts/${button.dataset.delete}`, { method: 'DELETE' });
    notify('Rascunho excluído.');
    await draftsView();
  }));
}

function bindCommon() {
  document.querySelector('[data-action="logout"]')?.addEventListener('click', async () => {
    await api('/fiscal/api/auth/logout', { method: 'POST', body: '{}' });
    state.user = null;
    loginView();
  });
}

async function route() {
  try {
    if (!state.user) {
      try {
        const me = await api('/fiscal/api/auth/me');
        state.user = me.user;
        state.demoMode = me.demoMode;
        state.environment = me.environment;
        state.runtimeMode = me.runtimeMode;
        state.allowProduction = me.allowProduction;
        state.pollIntervalMs = me.pollIntervalMs || 5000;
      } catch { return loginView(); }
    }
    if (!state.services.length) state.services = (await api('/fiscal/api/services')).items;
    const hash = location.hash || '#/';
    if (hash === '#/' || hash === '') return dashboardView();
    if (hash === '#/nova') return newInvoiceView();
    if (hash === '#/notas') return invoicesView();
    if (hash === '#/rascunhos') return draftsView();
    const invoice = hash.match(/^#\/notas\/(\d+)$/);
    if (invoice) return invoiceDetailView(invoice[1]);
    const draft = hash.match(/^#\/rascunhos\/(\d+)$/);
    if (draft) return newInvoiceView(draft[1]);
    location.hash = '#/';
  } catch (error) {
    console.error(error);
    notify(error.message, 'error');
  }
}

window.addEventListener('hashchange', route);
route();
