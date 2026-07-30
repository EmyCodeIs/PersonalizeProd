# Áreas do repositório PersonalizeProd

Este arquivo existe para evitar que trabalhos paralelos misturem mudanças do bot com mudanças do painel.

## 1. Painel unificado

Responsabilidade deste fluxo de trabalho:

- login do painel;
- visão geral;
- interface de conexão do WhatsApp;
- leitura de QR Code e estado da sessão;
- proxy autenticado para o módulo fiscal;
- identidade visual e responsividade do painel.

Arquivos pertencentes ao painel:

```text
src/modules/panel/
public/panel/
scripts/test-unified-panel.js
docs/PAINEL-UNIFICADO.md
```

Branch reservada:

```text
agent/painel-unificado-personalize
```

## 2. Módulo fiscal

Responsabilidade deste fluxo de trabalho:

- integração Focus;
- emissão, consulta e cancelamento de NFS-e;
- rascunhos e histórico;
- banco SQLite fiscal;
- PDF e XML;
- modo demonstração, homologação e produção.

Arquivos pertencentes ao fiscal:

```text
src/modules/fiscal/
public/fiscal/
scripts/test-fiscal-integration.js
scripts/migrate-fiscal-local.ps1
data/fiscal/                    # somente local, ignorado pelo Git
storage/fiscal-documents/       # somente local, ignorado pelo Git
```

## 3. Bot e atendimento

Pertencem ao outro fluxo de desenvolvimento:

```text
src/core/
src/flow/
src/channel/
src/services/                   # exceto integrações explicitamente compartilhadas
src/config/
data operacional do bot
scripts de fluxo, handoff, fila, buffer e sessão
```

Mudanças de mensagens, menus, handoff, etiquetas, filas, buffers, sessão e atendimento não devem ser feitas na branch do painel.

## 4. Arquivos compartilhados

Estes arquivos conectam os módulos e exigem atenção ao integrar trabalhos paralelos:

```text
src/start-with-required-labels.js
package.json
.env.example
.gitignore
.github/workflows/
```

Neles, alterações do painel devem se limitar a:

- importar e iniciar `src/modules/panel`;
- importar e iniciar `src/modules/fiscal`;
- registrar scripts e configurações desses módulos;
- nunca alterar regras do atendimento.

## Regra para trabalhos em chats diferentes

1. Cada chat trabalha em sua própria branch.
2. O chat do painel altera somente os caminhos listados nas áreas 1 e 2, além dos pontos compartilhados necessários.
3. O chat do bot não altera `src/modules/panel`, `src/modules/fiscal`, `public/panel` ou `public/fiscal`.
4. Antes de juntar branches, executar `npm test` e revisar especialmente os arquivos compartilhados.
5. Não copiar uma branch inteira por cima da outra. Integrar por merge, rebase ou commits específicos após revisão.

## Estrutura resumida

```text
PersonalizeProd
├── src
│   ├── modules
│   │   ├── panel       # painel, login, conexão e proxy
│   │   └── fiscal      # sistema completo de NFS-e
│   ├── core            # regras do bot
│   ├── flow            # conversa e atendimento
│   └── services        # serviços operacionais do bot
├── public
│   ├── panel            # interface principal
│   └── fiscal           # interface fiscal incorporada
└── docs
    ├── AREAS-DO-REPOSITORIO.md
    └── PAINEL-UNIFICADO.md
```
