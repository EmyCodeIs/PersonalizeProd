# Painel unificado da Personalize

## Objetivo

Centralizar em uma única interface:

- visão geral da operação;
- estado da conexão do WPPConnect;
- QR Code e código de pareamento;
- acesso ao mesmo Chrome compartilhado por noVNC;
- módulo de emissão e gestão de NFS-e.

O painel visual pertence ao `PersonalizeProd`, mas os módulos continuam isolados internamente. Uma falha fiscal não pode interromper o atendimento do WhatsApp, e uma reconexão do bot não pode afetar o banco fiscal.

## Estado atual desta branch

Implementado:

- login único do painel;
- identidade visual em preto e branco, com amarelo, vermelho e azul apenas como acentos;
- visão geral;
- leitura do estado publicado em `data/qr-status/status.json`;
- exibição do QR Code e código de pareamento;
- botão para abrir o controle remoto existente;
- ação administrativa de logout do WhatsApp usando o servidor local `qrAdminServer`;
- servidor do painel isolado em `127.0.0.1:3030`;
- falhas do painel não encerram o processo do bot;
- testes de sintaxe e leitura do status.

Ainda não migrado:

- banco e tabelas do PersonalizeNF;
- integração Focus;
- emissão, consulta e cancelamento;
- PDF e XML fiscais;
- histórico de notas e rascunhos.

Até essa migração terminar, o repositório `PersonalizeNF` deve ser preservado e não deve ser apagado.

## Configuração

O painel usa as variáveis abaixo:

```env
UNIFIED_PANEL_ENABLED=true
PANEL_HOST=127.0.0.1
PANEL_PORT=3030
PANEL_ADMIN_EMAIL=contato@personalizeseuambiente.com.br
PANEL_ADMIN_PASSWORD=troque-por-uma-senha-forte
PANEL_SESSION_SECRET=use-uma-chave-aleatoria-com-32-ou-mais-caracteres

# Dados já existentes do bot
QR_STATUS_JSON=data/qr-status/status.json
QR_ADMIN_HOST=127.0.0.1
QR_ADMIN_PORT=3210
SESSION_ACCESS_PUBLIC_URL=

# Temporário durante a migração fiscal
FISCAL_PANEL_URL=
FISCAL_MIGRATION_STATE=preparando
```

Compatibilidade:

- se `PANEL_ADMIN_PASSWORD` estiver vazio, o sistema tenta `ADMIN_PASSWORD` e depois `SESSION_ACCESS_PASSWORD`;
- se `PANEL_ADMIN_EMAIL` estiver vazio, usa `ADMIN_EMAIL` ou o e-mail padrão da Personalize;
- se `PANEL_SESSION_SECRET` estiver vazio, uma chave temporária é gerada ao iniciar. Nesse caso, o login expira quando o processo reinicia.

## Acesso local

```bash
npm install
npm start
```

Abra:

```text
http://127.0.0.1:3030
```

## Publicação na VPS

O servidor deve continuar em `127.0.0.1:3030` e ser publicado pelo Nginx com HTTPS. O noVNC continua separado em `127.0.0.1:6080`.

Arquitetura recomendada:

```text
Nginx / HTTPS
  ├─ /              → Painel unificado :3030
  └─ /whatsapp/     → noVNC :6080

Processo do bot
  ├─ WPPConnect
  ├─ qrAdminServer :3210 somente local
  └─ painel unificado :3030 somente local
```

## Migração fiscal recomendada

1. Copiar o núcleo fiscal para `src/modules/fiscal`.
2. Manter um arquivo SQLite fiscal próprio dentro de `data/fiscal/`.
3. Reutilizar o login do painel unificado.
4. Montar as rotas fiscais em `/api/fiscal/*`.
5. Mover a interface de notas para a navegação atual.
6. Validar demonstração local.
7. Validar homologação real da Focus.
8. Somente depois ativar produção.

A migração não deve reutilizar diretamente as tabelas operacionais do bot. O painel é único; os dados e responsabilidades continuam separados.


## Módulo fiscal integrado

O núcleo completo do antigo PersonalizeNF agora está versionado em `src/modules/fiscal` e é iniciado automaticamente como processo local isolado. O painel principal faz proxy autenticado em `/fiscal/`, portanto não existe segundo login nem exposição direta da porta interna.

- banco fiscal: `data/fiscal/personalize-nf.sqlite`;
- documentos: `storage/fiscal-documents`;
- processo interno: `127.0.0.1:3031`;
- entrada única: painel em `127.0.0.1:3030`;
- falha fiscal não encerra o bot.

Para trazer banco, documentos e configurações locais do projeto antigo no Windows:

```powershell
.\scripts\migrate-fiscal-local.ps1
```
