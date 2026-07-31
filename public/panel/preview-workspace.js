'use strict';

(() => {
  if (!window.__PERSONALIZE_FRONTEND_PREVIEW__) return;
  const app = document.querySelector('#app');
  if (!app) return;

  const leads = [
    ['Ana Clara', '(31) 99842-1160', 'Letreiro em acrílico', 'Parado há 24h', 'warning', 'Sem responsável', 'há 26h'],
    ['Rafael Martins', '(31) 99118-6402', 'Placa em ACM', 'Com vendedor', 'info', 'Mariana', 'há 18 min'],
    ['Camila Rocha', '(31) 98777-3321', 'Letreiro espelhado', 'Novo', 'success', 'Não atribuído', 'há 4 min'],
    ['Studio Aurora', '(31) 98451-0920', 'Adesivo de parede', 'Recuperado', 'neutral', 'Pedro', 'ontem'],
  ];
  const invoices = [
    ['NFS-e 000184', 'Studio Aurora LTDA', 'Produção de letreiro', 'R$ 1.480,00', 'Autorizada', 'success'],
    ['PNF-7A92F1', 'Mercado Oliveira', 'Serviços de plotagem', 'R$ 690,00', 'Processando', 'info'],
    ['NFS-e 000183', 'Clínica Horizonte', 'Produção de letreiro', 'R$ 2.210,00', 'Autorizada', 'success'],
    ['PNF-1C80BD', 'Café Bento', 'Serviços de plotagem', 'R$ 430,00', 'Com erro', 'danger'],
  ];
  let fiscalTab = 'dashboard';
  let settingsTab = 'empresa';
  let scheduled = false;

  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  const svg = (path) => `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;
  const icons = {
    home: svg('<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>'),
    leads: svg('<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/>'),
    chat: svg('<path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z"/><path d="M8 9h8M8 13h5"/>'),
    note: svg('<path d="M6 2h9l3 3v17H6z"/><path d="M14 2v5h5"/><path d="M9 12h6M9 16h6"/>'),
    plug: svg('<path d="M12 22v-5M9 8V2M15 8V2M18 8v3a6 6 0 0 1-12 0V8zM8 8h8"/>'),
    gear: svg('<circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 1 1-14 0 7 7 0 0 1 14 0Z"/>'),
    alert: svg('<path d="M10.3 2.8 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 2.8a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/>'),
    arrow: svg('<path d="m9 18 6-6-6-6"/>'),
  };

  function route() {
    const hash = location.hash || '#/';
    if (hash.startsWith('#/leads')) return 'leads';
    if (hash.startsWith('#/conexao')) return 'connection';
    if (hash.startsWith('#/notas')) return 'fiscal';
    if (hash.startsWith('#/integracao-fiscal')) return 'integration';
    if (hash.startsWith('#/configuracoes')) return 'settings';
    return 'overview';
  }

  function nav() {
    const groups = [
      ['Geral', [['#/', 'Visão geral', 'overview', icons.home]]],
      ['Atendimento', [['#/leads', 'Leads', 'leads', icons.leads]]],
      ['Operação', [['#/conexao', 'Conexão', 'connection', icons.chat]]],
      ['Fiscal', [['#/notas', 'Notas fiscais', 'fiscal', icons.note], ['#/integracao-fiscal', 'Integração fiscal', 'integration', icons.plug]]],
      ['Administração', [['#/configuracoes', 'Configurações', 'settings', icons.gear]]],
    ];
    const sidebar = document.querySelector('.sidebar-nav');
    if (sidebar) {
      sidebar.dataset.structure = route();
      sidebar.innerHTML = groups.map(([label, items]) => `<section class="nav-group"><div class="nav-group-label">${label}</div><div class="nav-group-links">${items.map(([href,text,id,icon]) => `<a class="nav-link ${route() === id ? 'active' : ''}" href="${href}"><span class="nav-icon">${icon}</span><span>${text}</span></a>`).join('')}</div></section>`).join('');
    }
    const mobile = document.querySelector('.mobile-nav');
    if (mobile) mobile.innerHTML = groups.flatMap(([,items]) => items).map(([href,text,id,icon]) => `<a class="${route() === id ? 'active' : ''}" href="${href}"><span>${icon}</span><small>${text.replace('Visão geral','Início').replace('Integração fiscal','Fiscal').replace('Configurações','Ajustes')}</small></a>`).join('');
  }

  const banner = () => `<div class="pw-banner">${icons.alert}<div><strong>Prévia de frontend</strong><p>Dados demonstrativos. Bot, WPPConnect e Focus permanecem desligados.</p></div></div>`;
  const heading = (area,title,description,actions='') => `<div class="pw-heading"><div><span>${area}</span><h2>${title}</h2><p>${description}</p></div><div class="pw-actions">${actions}</div></div>`;
  const metric = (label,value,foot,tone='') => `<article class="pw-metric ${tone}"><span>${label}</span><strong>${value}</strong><small>${foot}</small></article>`;
  const status = (text,tone) => `<span class="pw-status ${tone}">${text}</span>`;

  function overview() {
    return banner()+heading('Geral','Visão geral','Resumo da operação, atendimento e fiscal da Personalize.','<button class="button secondary" data-demo>Atualizar visão</button>')+
      `<section class="pw-metrics">${metric('Leads que precisam de ação','6','2 parados há mais de 24 horas','warning')}${metric('WhatsApp','Conectando','Sessão em modo de prévia','info')}${metric('Notas autorizadas','18','R$ 21.430,00 no mês','success')}${metric('Pendências fiscais','3','1 erro e 2 códigos a confirmar','danger')}</section>
      <section class="pw-grid"><article class="pw-card wide"><div class="pw-card-head"><div><small>Prioridades</small><h3>O que precisa de atenção</h3></div></div><div class="pw-attention"><a href="#/leads">${icons.leads}<div><strong>2 leads parados há mais de 24h</strong><p>Clientes aguardando busca ativa.</p></div>${icons.arrow}</a><a href="#/integracao-fiscal">${icons.note}<div><strong>1 nota com rejeição</strong><p>Revisar serviço antes de tentar novamente.</p></div>${icons.arrow}</a><a href="#/conexao">${icons.chat}<div><strong>Conexão preparada</strong><p>A tela aguarda o estado real do WPPConnect.</p></div>${icons.arrow}</a></div></article>
      <article class="pw-card"><div class="pw-card-head"><div><small>Atendimento</small><h3>Funil de leads</h3></div></div><div class="pw-bars"><div><span>Novo</span><strong>4</strong><i style="--w:62%"></i></div><div><span>Em atendimento</span><strong>7</strong><i style="--w:100%"></i></div><div><span>Orçamento enviado</span><strong>5</strong><i style="--w:74%"></i></div><div><span>Convertido</span><strong>3</strong><i style="--w:45%"></i></div></div></article>
      <article class="pw-card"><div class="pw-card-head"><div><small>Fiscal</small><h3>Resumo do mês</h3></div></div><div class="pw-total"><strong>R$ 21.430,00</strong><span>valor autorizado</span><i><b></b></i><small>18 autorizadas · 2 processando · 1 com erro</small></div><a class="button secondary full" href="#/notas">Abrir notas fiscais</a></article>
      <article class="pw-card wide"><div class="pw-card-head"><div><small>Módulos</small><h3>Acesso rápido</h3></div></div><div class="pw-shortcuts"><a href="#/leads">${icons.leads}<div><strong>Leads</strong><small>Contatos e responsáveis</small></div></a><a href="#/conexao">${icons.chat}<div><strong>Conexão</strong><small>QR e estado da sessão</small></div></a><a href="#/notas">${icons.note}<div><strong>Notas fiscais</strong><small>Emissão e documentos</small></div></a><a href="#/configuracoes">${icons.gear}<div><strong>Configurações</strong><small>Empresa, usuários e regras</small></div></a></div></article></section>`;
  }

  function leadsView() {
    const rows = leads.map(([name,phone,service,label,tone,owner,last],index) => `<article class="pw-lead" data-lead="${index}"><div class="pw-person"><span>${name.split(/\s+/).slice(0,2).map(x=>x[0]).join('')}</span><div><strong>${name}</strong><small>${phone}</small></div></div><div><small>Interesse</small><strong>${service}</strong></div><div><small>Última atividade</small><strong>${last}</strong></div><div><small>Responsável</small><strong>${owner}</strong>${status(label,tone)}</div><button>${icons.arrow}</button></article>`).join('');
    return banner()+heading('Atendimento','Leads','Priorize contatos parados, acompanhe responsáveis e registre próximos passos.','<button class="button secondary" data-demo>Exportar</button><button class="button primary" data-demo>Novo lead</button>')+
      `<section class="pw-metrics">${metric('Novos hoje','4','Entraram nas últimas 24 horas')}${metric('Parados há 24h','2','Precisam de busca ativa','warning')}${metric('Com vendedor','7','Em atendimento manual','info')}${metric('Convertidos no mês','12','36% dos encerrados','success')}</section>
      <section class="pw-card no-pad"><div class="pw-toolbar"><label>${icons.leads}<input data-search placeholder="Buscar nome, telefone ou serviço"></label><select data-filter><option value="">Todos os status</option><option>Parado há 24h</option><option>Com vendedor</option><option>Novo</option><option>Recuperado</option></select><select><option>Todos os vendedores</option><option>Sem responsável</option><option>Mariana</option><option>Pedro</option></select></div><div data-lead-list>${rows}</div></section><aside class="pw-drawer" hidden><div data-close></div><section><button data-close>×</button><div data-detail></div></section></aside>`;
  }

  const fiscalTabs = () => `<nav class="pw-tabs">${[['dashboard','Visão geral'],['new','Nova NFS-e'],['drafts','Rascunhos'],['issued','Notas emitidas'],['errors','Erros']].map(([id,label])=>`<button class="${fiscalTab===id?'active':''}" data-fiscal="${id}">${label}</button>`).join('')}</nav>`;
  function invoiceRows() { return invoices.map(([number,client,service,value,label,tone])=>`<div class="pw-invoice"><div><strong>${number}</strong><small>Hoje</small></div><div><strong>${client}</strong><small>${service}</small></div><strong>${value}</strong>${status(label,tone)}<button>${icons.arrow}</button></div>`).join(''); }
  function fiscalBody() {
    if (fiscalTab === 'new') return `<article class="pw-card pw-form"><div class="pw-progress"><span class="active">1. Cliente</span><span class="active">2. Serviço</span><span>3. Prestação</span><span>4. Conferência</span></div><section><h3>Dados do cliente</h3><div class="pw-fields"><label>CPF ou CNPJ<div><input placeholder="00.000.000/0000-00"><button>Buscar</button></div></label><label>Nome ou razão social<input placeholder="Nome do cliente"></label><label>E-mail<input placeholder="cliente@email.com"></label><label>CEP<input placeholder="00000-000"></label><label class="span">Endereço<input placeholder="Rua, número, complemento e bairro"></label></div></section><section><h3>Serviço</h3><div class="pw-services"><button class="active">Produção de letreiro<small>Comunicação visual personalizada</small></button><button>Serviços de plotagem<small>Aplicação e instalação</small></button></div><div class="pw-fields"><label class="span">Descrição<textarea placeholder="Descrição que aparecerá na nota"></textarea></label><label>Valor<input placeholder="R$ 0,00"></label><label>Competência<input type="date"></label></div></section><footer><button class="button secondary" data-demo>Salvar rascunho</button><button class="button primary" data-demo>Conferir emissão</button></footer></article>`;
    if (fiscalTab === 'drafts') return `<article class="pw-card"><div class="pw-card-head"><div><small>Pendentes</small><h3>Rascunhos salvos</h3></div><button class="button primary" data-fiscal="new">Novo</button></div><div class="pw-drafts">${['Studio Aurora LTDA|Produção de letreiro · R$ 1.480,00','Mercado Oliveira|Plotagem · R$ 690,00','Sem cliente definido|Serviço não selecionado'].map(x=>{const [a,b]=x.split('|');return `<article><small>Atualizado recentemente</small><h4>${a}</h4><p>${b}</p><button class="button secondary" data-demo>Editar</button></article>`}).join('')}</div></article>`;
    if (fiscalTab === 'issued') return `<article class="pw-card no-pad"><div class="pw-toolbar"><label>${icons.note}<input placeholder="Buscar número, cliente ou documento"></label><select><option>Todos os status</option><option>Autorizadas</option><option>Processando</option><option>Com erro</option></select><button class="button secondary" data-demo>Exportar CSV</button></div><div class="pw-invoices">${invoiceRows()}</div></article>`;
    if (fiscalTab === 'errors') return `<section class="pw-grid"><article class="pw-card wide"><div class="pw-card-head"><div><small>Precisa de ação</small><h3>Emissões com erro</h3></div></div><div class="pw-error">${icons.alert}<div><strong>PNF-1C80BD · Café Bento</strong>${status('Rejeitada','danger')}<p>O código nacional informado para o serviço não é aceito no município.</p><button class="button primary" data-demo>Corrigir rascunho</button><button class="button secondary" data-demo>Detalhes técnicos</button></div></div></article><article class="pw-card"><div class="pw-card-head"><div><small>Checklist</small><h3>Antes de reenviar</h3></div></div><ul class="pw-check"><li>Conferir serviço fiscal</li><li>Validar município</li><li>Revisar descrição</li><li>Confirmar ambiente</li></ul></article></section>`;
    return `<section class="pw-metrics compact">${metric('Autorizadas','18','R$ 21.430,00','success')}${metric('Processando','2','Aguardando retorno','info')}${metric('Com erro','1','Precisa de correção','danger')}${metric('Rascunhos','3','Não emitidos','warning')}</section><section class="pw-grid"><article class="pw-card wide"><div class="pw-card-head"><div><small>Recentes</small><h3>Últimas movimentações</h3></div><button class="button secondary" data-fiscal="issued">Ver todas</button></div><div class="pw-invoices">${invoiceRows()}</div></article><article class="pw-card"><div class="pw-card-head"><div><small>Ações</small><h3>Atalhos fiscais</h3></div></div><div class="pw-stack"><button data-fiscal="new">${icons.note}<span><strong>Emitir nova NFS-e</strong><small>Começar preenchimento</small></span></button><button data-fiscal="drafts">${icons.home}<span><strong>Continuar rascunho</strong><small>3 aguardando</small></span></button><button data-fiscal="errors">${icons.alert}<span><strong>Revisar erros</strong><small>1 pendência</small></span></button></div></article></section>`;
  }
  function fiscalView() { return banner()+heading('Fiscal','Notas fiscais','Emissão, rascunhos, documentos e histórico.','<span class="pw-env">Homologação visual</span>')+fiscalTabs()+`<div>${fiscalBody()}</div>`; }

  function integrationView() {
    return banner()+heading('Fiscal','Integração fiscal','Saúde da Focus, ambiente, armazenamento e códigos tributários.','<button class="button secondary" data-demo>Testar integração</button>')+
      `<section class="pw-integration">${icons.plug}<div><small>Estado da integração</small><h3>Estrutura pronta para homologação</h3><p>Credenciais ficam protegidas no servidor.</p></div>${status('Disponível','success')}</section>
      <section class="pw-metrics compact">${metric('Ambiente','Homologação','Produção bloqueada','info')}${metric('Token Focus','Configurado','Valor protegido','success')}${metric('Webhook','Pendente','Sem confirmação','warning')}${metric('Armazenamento','Saudável','PDF e XML graváveis','success')}</section>
      <section class="pw-grid"><article class="pw-card wide"><div class="pw-card-head"><div><small>Diagnóstico</small><h3>Checklist da integração</h3></div></div><div class="pw-check-grid"><div class="done">✓<span><strong>Serviço fiscal acessível</strong><small>Processo interno preparado</small></span></div><div class="done">✓<span><strong>Banco fiscal disponível</strong><small>SQLite separado</small></span></div><div class="done">✓<span><strong>Token de homologação</strong><small>Configurado e mascarado</small></span></div><div class="wait">!<span><strong>Códigos NBS e IBS/CBS</strong><small>Confirmação contábil pendente</small></span></div><div class="wait">!<span><strong>Webhook Focus</strong><small>Validar recebimento externo</small></span></div><div class="lock">•<span><strong>Produção real</strong><small>Bloqueada até homologar</small></span></div></div></article><article class="pw-card"><div class="pw-card-head"><div><small>Ambientes</small><h3>Segurança fiscal</h3></div></div><div class="pw-environments"><div class="on"><i></i><span><strong>Demonstração</strong><small>Interface simulada</small></span></div><div class="on"><i></i><span><strong>Homologação</strong><small>Testes sem validade fiscal</small></span></div><div><i></i><span><strong>Produção</strong><small>Bloqueada</small></span></div></div><a href="#/notas" class="button primary full">Abrir notas fiscais</a></article></section>`;
  }

  const settingsTabs = [['empresa','Empresa'],['usuarios','Usuários'],['atendimento','Atendimento'],['bot','Bot'],['fiscal','Fiscal'],['aparencia','Aparência'],['sistema','Sistema'],['seguranca','Segurança']];
  const field = (label,value,type='text') => `<label>${label}<input type="${type}" value="${esc(value)}"></label>`;
  function settingsBody() {
    if (settingsTab === 'usuarios') return `<div class="pw-section"><h3>Usuários e permissões</h3><p>Controle visual dos perfis que acessarão o painel.</p><button class="button primary" data-demo>Adicionar usuário</button><div class="pw-users">${[['ES','Emilly Santos','Administrador · Todos os módulos'],['MA','Mariana Alves','Vendedor · Leads e suas notas'],['FI','Financeiro','Fiscal · Sem acesso à conexão']].map(([i,n,r])=>`<article><b>${i}</b><span><strong>${n}</strong><small>${r}</small></span>${status(n==='Financeiro'?'Convite pendente':'Ativo',n==='Financeiro'?'neutral':'success')}<button>•••</button></article>`).join('')}</div></div>`;
    if (settingsTab === 'atendimento') return `<div class="pw-section"><h3>Regras de atendimento</h3><p>Prazos e alertas do futuro backend de leads.</p><div class="pw-fields">${field('Considerar lead parado após','24 horas')}${field('Segundo lembrete após','48 horas')}${field('Horário inicial','08:00','time')}${field('Horário final','18:00','time')}<label class="span">Motivos de perda<textarea>Sem retorno\nPreço\nPrazo\nEscolheu concorrente</textarea></label></div><div class="pw-toggles"><label><input type="checkbox" checked><span><strong>Notificar vendedor responsável</strong><small>Alerta após 24 horas sem atividade.</small></span></label><label><input type="checkbox" checked><span><strong>Gerar TXT da conversa</strong><small>Histórico completo no detalhe do lead.</small></span></label></div></div>`;
    if (settingsTab === 'bot') return `<div class="pw-section"><h3>Comportamento do bot</h3><p>Somente estrutura visual; nada será enviado ao runtime.</p><div class="pw-fields">${field('Buffer do primeiro input','8000 ms')}${field('Buffer padrão','4500 ms')}${field('Sessão temporária','24 horas')}${field('Atendimentos simultâneos','2')}<label class="span">Mensagem fora do horário<textarea>Recebemos sua mensagem e retornaremos no próximo período de atendimento.</textarea></label></div><div class="pw-warning">${icons.alert} Alterações futuras exigirão validação e reinício controlado.</div></div>`;
    if (settingsTab === 'fiscal') return `<div class="pw-section"><h3>Configurações fiscais</h3><p>Dados não sensíveis. Tokens continuam somente no servidor.</p><div class="pw-fields">${field('Inscrição municipal','04913840010')}${field('Série DPS','1')}${field('Regime do Simples','1')}${field('Tributos aproximados','8,5%')}${field('Código municipal - Plotagem','005')}${field('Código nacional - Plotagem','130501')}${field('Código municipal - Produção','001')}${field('Código nacional - Produção','240102')}</div><div class="pw-secret"><div>Token homologação<strong>Configurado</strong></div><div>Token produção<strong>Não configurado</strong></div><div>Webhook<strong>Pendente</strong></div></div></div>`;
    if (settingsTab === 'aparencia') return `<div class="pw-section"><h3>Aparência</h3><p>Preferências visuais por usuário.</p><div class="pw-themes"><button class="active"><i class="light"></i><strong>Claro</strong><small>Padrão atual</small></button><button><i class="dark"></i><strong>Escuro</strong><small>Etapa futura</small></button><button><i class="system"></i><strong>Sistema</strong><small>Segue o dispositivo</small></button></div></div>`;
    if (settingsTab === 'sistema') return `<div class="pw-section"><h3>Saúde e armazenamento</h3><p>Estrutura da futura central de diagnóstico.</p><div class="pw-system">${[['Versão','0.7.3','Frontend modular'],['Banco operacional','Saudável','SQLite criptografado'],['Banco fiscal','Saudável','SQLite independente'],['Backup','Pendente','Rotina não conectada']].map(x=>`<article><small>${x[0]}</small><strong>${x[1]}</strong><span>${x[2]}</span></article>`).join('')}</div><div class="pw-stack"><button data-demo>${icons.home}<span><strong>Baixar diagnóstico</strong><small>Logs, versão e módulos</small></span></button><button data-demo>${icons.gear}<span><strong>Verificar integridade</strong><small>Indisponível na prévia</small></span></button></div></div>`;
    if (settingsTab === 'seguranca') return `<div class="pw-section"><h3>Segurança da conta</h3><p>Acesso e auditoria administrativa.</p><div class="pw-security"><article>${icons.gear}<span><strong>Alterar senha</strong><small>Senha do usuário atual</small></span><button class="button secondary" data-demo>Alterar</button></article><article>${icons.home}<span><strong>Sessões abertas</strong><small>1 sessão ativa</small></span><button class="button secondary" data-demo>Gerenciar</button></article><article>${icons.alert}<span><strong>Autenticação em duas etapas</strong><small>Planejada</small></span><button class="button secondary" disabled>Em breve</button></article></div></div>`;
    return `<div class="pw-section"><h3>Dados da empresa</h3><p>Informações usadas no painel e nos documentos.</p><div class="pw-fields">${field('Nome exibido','Personalize Seu Ambiente')}${field('Razão social','PERSONALIZE ADESIVOS DECORATIVOS LTDA')}${field('CNPJ','18.342.858/0001-08')}${field('Telefone comercial','(31) 0000-0000')}${field('Instagram','@personalizeseuambiente')}${field('Fuso horário','America/Sao_Paulo')}</div></div>`;
  }
  function settingsView() { return banner()+heading('Administração','Configurações','Empresa, usuários, regras, aparência e segurança.','<button class="button primary" data-demo>Salvar alterações</button>')+`<section class="pw-settings"><nav>${settingsTabs.map(([id,label])=>`<button class="${settingsTab===id?'active':''}" data-settings="${id}">${label}</button>`).join('')}</nav><article class="pw-card">${settingsBody()}</article></section>`; }

  function setPage(name, html) {
    const content = document.querySelector('.content');
    const title = document.querySelector('.topbar h1');
    if (!content || !title) return;
    if (typeof window.stopPolling === 'function') window.stopPolling();
    title.textContent = ({overview:'Visão geral',leads:'Leads',fiscal:'Notas fiscais',integration:'Integração fiscal',settings:'Configurações'}[name] || 'Painel');
    content.dataset.previewRoute = `${name}:${fiscalTab}:${settingsTab}`;
    content.innerHTML = html;
    bind();
  }

  function render() {
    scheduled = false;
    nav();
    const name = route();
    if (name === 'connection') return;
    if (name === 'leads') return setPage(name, leadsView());
    if (name === 'fiscal') return setPage(name, fiscalView());
    if (name === 'integration') return setPage(name, integrationView());
    if (name === 'settings') return setPage(name, settingsView());
    setPage('overview', overview());
  }

  function openLead(index) {
    const item = leads[index];
    const drawer = document.querySelector('.pw-drawer');
    const target = drawer?.querySelector('[data-detail]');
    if (!item || !drawer || !target) return;
    target.innerHTML = `<span class="pw-kicker">Lead LD-${1048-index}</span><div class="pw-detail-title"><b>${item[0].split(/\s+/).slice(0,2).map(x=>x[0]).join('')}</b><div><h3>${item[0]}</h3><p>${item[1]}</p></div></div>${status(item[3],item[4])}<div class="pw-detail-grid"><div><small>Interesse</small><strong>${item[2]}</strong></div><div><small>Responsável</small><strong>${item[5]}</strong></div><div><small>Etapa</small><strong>Aguardando medida</strong></div><div><small>Última atividade</small><strong>${item[6]}</strong></div></div><div class="pw-conversation"><h4>Resumo da conversa</h4><p class="client"><small>Cliente · 10:42</small>Oi, queria saber o valor de um letreiro para minha loja.</p><p class="bot"><small>Bot · 10:42</small>Claro! Vou coletar algumas informações para preparar seu orçamento.</p><p class="client"><small>Cliente · 10:44</small>Queria preto com a logo da loja.</p></div><footer><button class="button primary" data-demo>Assumir lead</button><button class="button secondary" data-demo>Baixar TXT</button><button class="button secondary" data-demo>Abrir WhatsApp</button></footer>`;
    drawer.hidden = false;
  }

  function bind() {
    document.querySelectorAll('[data-fiscal]').forEach(b=>b.addEventListener('click',()=>{ fiscalTab=b.dataset.fiscal; setPage('fiscal',fiscalView()); }));
    document.querySelectorAll('[data-settings]').forEach(b=>b.addEventListener('click',()=>{ settingsTab=b.dataset.settings; setPage('settings',settingsView()); }));
    document.querySelectorAll('[data-lead]').forEach(b=>b.addEventListener('click',()=>openLead(Number(b.dataset.lead))));
    document.querySelectorAll('[data-close]').forEach(b=>b.addEventListener('click',()=>{ const d=document.querySelector('.pw-drawer'); if(d)d.hidden=true; }));
    document.querySelector('[data-search]')?.addEventListener('input',e=>{ const q=e.target.value.toLowerCase(); document.querySelectorAll('.pw-lead').forEach(x=>x.hidden=q&&!x.textContent.toLowerCase().includes(q)); });
    document.querySelector('[data-filter]')?.addEventListener('change',e=>{ const q=e.target.value; document.querySelectorAll('.pw-lead').forEach(x=>x.hidden=q&&!x.textContent.includes(q)); });
    document.querySelectorAll('[data-demo]').forEach(b=>b.addEventListener('click',e=>{e.stopPropagation(); if(typeof window.notify==='function')window.notify('Ação visual: o backend será conectado em uma próxima etapa.');}));
  }

  function schedule() { if (scheduled) return; scheduled=true; requestAnimationFrame(render); }
  new MutationObserver(schedule).observe(app,{childList:true,subtree:true});
  window.addEventListener('hashchange',schedule);
  schedule();
})();
