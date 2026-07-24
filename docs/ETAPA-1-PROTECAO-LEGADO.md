# Etapa 1 — Proteção e mapeamento da produção

## Base oficial

- Repositório: `EmyCodeIs/PersonalizeProd`
- Branch ativa: `main`
- Commit registrado na VPS: `fe6ca12df261015fdca9a2df87caa608ac51c944`
- Pacote: `personalize-wppconnect-cliente-flow`
- Versão: `0.7.3`
- Entrada: `src/start-with-required-labels.js`

Esta etapa não corrige handoff, recuperação, etiquetas, sincronização ou `/resetarsys`. Ela transforma o comportamento atualmente publicado em uma referência verificável para que as correções seguintes não apaguem o que já funciona.

## O que foi protegido

O arquivo `docs/production-baseline.json` registra hashes SHA-256 de:

- entrada e configuração da aplicação;
- bootstrap e pipeline principal;
- mensagens e menus comerciais;
- fluxo de atendimento e correções de fluxo carregadas por preload;
- catálogo, suporte e espessuras;
- todos os arquivos enviados ao cliente em `assets/`;
- ordem exata dos preloads carregados na inicialização.

O teste `scripts/test-production-baseline.js` falha quando um item protegido muda sem uma revisão explícita do baseline.

## Regras para as próximas etapas

Uma mudança futura em arquivo protegido não é automaticamente proibida, mas precisa ser explícita:

1. explicar o motivo;
2. demonstrar que o comportamento comercial preservado continua igual;
3. atualizar os testes de caracterização necessários;
4. atualizar o baseline somente no mesmo commit da alteração intencional;
5. listar o arquivo e o efeito no PR.

Não é permitido atualizar o hash apenas para fazer o teste passar.

## Arquitetura real da versão ativa

```text
npm start
└─ src/start-with-required-labels.js
   ├─ carrega dotenv e proteção de logs
   ├─ instala políticas e preloads em ordem definida
   ├─ executa manutenção segura de tokens e cache
   ├─ inicia serviço administrativo de QR
   ├─ abre o armazenamento configurado
   └─ require('./bootstrap')
      ├─ prepara acesso local ao Chrome no Windows
      ├─ envolve criação do canal para conferir etiquetas
      └─ require('./index')
         ├─ cria buffer e fila
         ├─ instala onMessage e onOutgoingMessage
         ├─ abre canal WPPConnect
         ├─ inicializa etiquetas
         ├─ tenta retomar sessões ativas
         └─ opcionalmente recupera não lidas
```

## Componentes principais

| Área | Arquivos principais | Responsabilidade atual |
|---|---|---|
| Entrada | `src/start-with-required-labels.js` | Ordem dos preloads, cache, banco e bootstrap |
| Bootstrap | `src/bootstrap.js` | Portal local, conferência inicial de etiquetas e carregamento do índice |
| Conexão | `src/services/wppconnectClient.js` | Cliente WPPConnect e transporte de mensagens |
| Pipeline | `src/index.js` | Identidade, handoff, buffer, fila, retomada e entrega ao fluxo |
| Fluxo | `src/flow/customerFlow.js` | Estado comercial e respostas do cliente |
| Correções legadas | `src/core/*Preload.js` | Sobrescritas carregadas sobre o fluxo principal |
| Sessões | `src/services/leadStore.js` | Sessões, perfis e leads persistidos |
| Handoff | `src/core/sellerHandoff.js`, `humanControlStore.js` | Bloqueio por humano e vendedor |
| Etiquetas | `serviceLabels.js` e preloads relacionados | Criação, aplicação e exclusividade operacional |
| Persistência | `src/services/persistence.js` | Arquivo ou SQLite criptografado |
| Assets | `assets/` | Imagens, catálogo e tabelas enviados ao cliente |

## Ordem atual dos preloads

A ordem é parte do comportamento da produção e está testada:

1. `safeLoggingPreload`
2. `operationalLabelPolicyPreload`
3. `exclusiveServiceLabelsPreload`
4. `serviceLabelAssignmentPreload`
5. `catalogMostruarioPreload`
6. `handoffPreload`
7. `resetCommandHandoffPreload`
8. `testCommandAccessPreload`
9. `resetCleanupPreload`
10. `safeResetCleanupOverridePreload`
11. `customerFlowFixPreload`
12. `preferredSellerNotePreload`
13. `completedFlowSilencePreload`
14. `runtimeReliabilityPreload`
15. `unreadReconnectRecoveryPreload`
16. `supportAndServicesPreload`
17. `supportLabelSelectionPreload`
18. `exactAcknowledgementPreload`
19. `bufferStagePolicyPreload`
20. `vpsReadinessPreload`
21. `sellerAliasHandoffPreload`
22. `sellerLabelEventsPreload`

## Estados comerciais identificados

O legado usa, entre outros:

- `inicio`
- `escolher_servico`
- `tipo_acrilico`
- `pantone`
- `cor_basica_qtd`
- `cor_basica_tipo`
- `cor_basica_select_solida`
- `cor_basica_select_espelhado`
- `tamanho`
- `espessura_extra_3mm`
- `espessura_personalizada`
- `arte_menu`
- `arte_coleta`
- `cidade`
- `envio`
- `endereco`
- `observacao_pedido_menu`
- `observacao_pedido_coleta`
- estados específicos de plotagem, outros e suporte
- `concluido`

## Testes existentes aproveitados

A produção já possuía testes para:

- configuração comercial;
- sequência de letreiros;
- prontidão e handoff;
- etiquetas de vendedor e etiquetas exclusivas;
- catálogo;
- cache e armazenamento;
- comandos de teste e reset;
- ambiente e Chrome da VPS.

A Etapa 1 não substitui esses testes. Ela adiciona uma trava de identidade da versão ativa.

## Limites desta validação

- A sintaxe foi validada localmente em 91 arquivos.
- O teste novo de baseline não depende de WPPConnect ou navegador.
- A instalação completa das dependências não foi concluída no ambiente de análise por limite de execução; portanto, a suíte completa existente ainda deve ser executada no Windows/VPS.
- Nenhum teste local substitui a homologação com o WhatsApp conectado.
