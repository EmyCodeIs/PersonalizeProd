# Painel unificado da Personalize

## Objetivo

Centralizar em uma única interface:

- visão geral da operação;
- estado da conexão do WPPConnect;
- QR Code e código de pareamento;
- acesso ao mesmo Chrome compartilhado por noVNC;
- emissão e gestão de NFS-e.

O painel é único, mas o bot, o painel e o fiscal permanecem separados internamente. Uma falha fiscal não pode interromper o atendimento do WhatsApp.

## Estrutura atual

```text
src/modules/panel/          backend, login, conexão e proxy
public/panel/               interface principal
src/modules/fiscal/         emissão, Focus, banco, PDF e XML
public/fiscal/              interface fiscal incorporada
```

A divisão completa das áreas está em `docs/AREAS-DO-REPOSITORIO.md`.

## Painel principal

Implementado:

- login único;
- identidade visual em preto e branco, com amarelo, vermelho e azul apenas como detalhes;
- visão geral;
- leitura de `data/qr-status/status.json`;
- QR Code e código de pareamento;
- acesso ao controle remoto existente;
- desconexão administrativa usando o `qrAdminServer`;
- navegação para o módulo fiscal;
- servidor local em `127.0.0.1:3030`.

## Módulo fiscal

O núcleo completo do antigo `PersonalizeNF` está em `src/modules/fiscal/`.

Inclui:

- demonstração local;
- homologação e produção separadas;
- integração Focus;
- emissão, consulta e cancelamento;
- rascunhos e histórico;
- banco SQLite fiscal próprio;
- PDF e XML;
- webhook opcional;
- proteção para impedir produção acidental.

O módulo fiscal roda em processo isolado:

```text
127.0.0.1:3031
```

O usuário acessa apenas:

```text
http://127.0.0.1:3030
```

O painel encaminha as rotas `/fiscal/*` internamente e não expõe diretamente a porta fiscal.

## Dados separados

```text
Bot:
  persistência operacional atual do PersonalizeProd

Fiscal:
  data/fiscal/personalize-nf.sqlite
  storage/fiscal-documents/
```

O banco fiscal nunca deve ser misturado às tabelas de atendimento.

## Configuração

```env
UNIFIED_PANEL_ENABLED=true
PANEL_HOST=127.0.0.1
PANEL_PORT=3030
PANEL_ADMIN_EMAIL=contato@personalizeseuambiente.com.br
PANEL_ADMIN_PASSWORD=troque-por-uma-senha-forte
PANEL_SESSION_SECRET=use-uma-chave-aleatoria-com-32-ou-mais-caracteres

QR_STATUS_JSON=data/qr-status/status.json
QR_ADMIN_HOST=127.0.0.1
QR_ADMIN_PORT=3210
SESSION_ACCESS_PUBLIC_URL=

FISCAL_MODULE_ENABLED=true
FISCAL_INTERNAL_HOST=127.0.0.1
FISCAL_INTERNAL_PORT=3031
FISCAL_DATA_DIRECTORY=./data/fiscal
FISCAL_DOCUMENT_DIRECTORY=./storage/fiscal-documents
```

As variáveis da Focus, empresa e serviços permanecem no mesmo `.env`, mas são consumidas somente pelo módulo fiscal.

## Migração local do antigo PersonalizeNF

Feche os dois sistemas antes de copiar os dados:

```powershell
.\scripts\migrate-fiscal-local.ps1 -SourcePath "C:\Users\Admin\Desktop\PersonalizeNF"
```

O script copia localmente:

- banco e histórico;
- PDF e XML;
- configurações fiscais;
- tokens da Focus;
- credenciais do painel quando ainda não existirem.

Nenhum `.env`, token, banco ou documento é enviado ao GitHub.

## Acesso local

```powershell
npm install
npm start
```

Abra:

```text
http://127.0.0.1:3030
```

## Publicação na VPS

Arquitetura prevista:

```text
Nginx / HTTPS
  ├─ /              → painel unificado :3030
  └─ /whatsapp/     → noVNC :6080

Processo principal
  ├─ bot e WPPConnect
  ├─ qrAdminServer :3210 somente local
  ├─ painel :3030 somente local
  └─ fiscal :3031 somente local e isolado
```

## Regra de desenvolvimento paralelo

Mudanças deste painel devem ficar na branch:

```text
agent/painel-unificado-personalize
```

Trabalhos de fluxo, mensagens, handoff, etiquetas, fila, buffer e sessão devem usar outra branch e não alterar `src/modules/panel`, `src/modules/fiscal`, `public/panel` ou `public/fiscal`.
