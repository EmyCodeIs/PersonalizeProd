# Matriz do `.env` informado × `PersonalizeProd/main`

Esta matriz descreve o commit `fe6ca12`. “Ignorada” significa que a variável não foi localizada no código ativo nem nos scripts de execução desse commit. Não significa que a intenção seja inválida; apenas que editar o valor hoje não produz o efeito esperado.

## Usadas diretamente pelo runtime do bot

`STORAGE_DRIVER`, `SQLITE_DATABASE_PATH`, `DATA_ENCRYPTION_KEY`, `WPP_SESSION_NAME`, `WPP_HEADLESS`, `WPP_BROWSER_ARGS`, `ALLOWED_CLIENT_NUMBERS`, `ALLOWED_CHAT_IDS`, `LID_NUMBER_MAP`, `FLOW_SESSION_TTL_HOURS`, `COMPLETED_SESSION_TTL_HOURS`, `MAX_CONCURRENT_CHATS`, `MAX_QUEUE_SIZE`, todos os buffers informados, notas, etiquetas, assets, identidade comercial e `HUMAN_BLOCK_HOURS`.

## Usadas por serviços ou scripts da VPS

- `NODE_ENV`: PM2 e preparação da VPS.
- `VPS_BACKUP_PASSPHRASE`: backup criptografado.
- `SESSION_ACCESS_*` e `SESSION_VNC_*`: noVNC/VNC e proxy local.
- `QR_ADMIN_HOST` e `QR_ADMIN_PORT`: servidor administrativo de QR.

Observação: `QR_ADMIN_ENABLED` não é consultada no commit ativo; o servidor administrativo é iniciado pelo entrypoint.

## Variáveis administrativas incompatíveis com a `main`

As seguintes variáveis do `.env` informado não são lidas:

```env
ADMIN_WHATSAPP_NUMBERS=
ADMIN_WHATSAPP_CHAT_IDS=
```

O código ativo procura:

```env
TEST_COMMAND_ALLOWED_CLIENT_NUMBERS=
TEST_COMMAND_ALLOWED_CHAT_IDS=
TEST_COMMAND_LID_NUMBER_MAP=
```

Na ausência de configuração administrativa explícita, existe lógica de fallback para as listas gerais, mas esse comportamento possui correções pendentes em branch separada e não faz parte da Etapa 1.

## Variáveis presentes no `.env`, mas ignoradas pela `main`

### Intenção BaseBots

```env
PERSONALIZE_AUTOMATION_ENABLED=
BOT_ID=
BASE_BOTS_DATA_DIR=
PERSONALIZE_DATA_DIR=
RECENT_MESSAGES_PER_CHAT=
MAX_RECOVERY_CANDIDATES=
RECOVER_ON_START=
```

A `main` não está integrada a um runtime BaseBots que consuma essas chaves.

### Limites ainda não implementados

```env
MAX_ACTIVE_BUFFERS=
EXTERNAL_LABELS_TRIGGER_HANDOFF=
OUTBOUND_SUBMISSION_TIMEOUT_MS=
OUTBOUND_DRAIN_TIMEOUT_MS=
REQUIRE_RESOLVED_LID_BEFORE_SEND=
AUTO_RECONNECT=
RECONNECT_INITIAL_DELAY_MS=
RECONNECT_MAX_DELAY_MS=
LOG_DIRECTORY=
LOG_RECENT_LIMIT=
```

### Prontidão e diretórios WPP não consumidos

```env
WPP_WAIT_FOR_LOGIN=
WPP_DEVICE_SYNC_TIMEOUT_MS=
WPP_READINESS_TIMEOUT_MS=
WPP_READINESS_POLL_MS=
WPP_LOG_QR=
WPP_TOKEN_DIRECTORY=
WPP_PROFILE_DIRECTORY=
WPP_CACHE_DIRECTORY=
WPP_TEMP_DIRECTORY=
WPP_DISK_CACHE_MAX_BYTES=
WPP_MEDIA_CACHE_MAX_BYTES=
```

A versão ativa define parte dessas decisões diretamente no código do cliente WPPConnect e usa outras variáveis de cache:

```env
TOKEN_CACHE_ROOT=
BROWSER_CACHE_DIR=
BROWSER_DISK_CACHE_MB=
BROWSER_MEDIA_CACHE_MB=
```

## Divergências importantes do `.env` enviado

1. `ADMIN_WHATSAPP_*` não autoriza `/resetarsys` na `main`.
2. `LID_NUMBER_MAP` usa telefone sem DDI no valor, enquanto o número administrativo foi informado com DDI. A normalização precisa ser validada antes de qualquer correção.
3. `ART_BUFFER_MS=12000` é aceito pela configuração principal, mas há preloads que podem impor políticas adicionais por etapa.
4. `WPP_TOKEN_DIRECTORY` e os demais diretórios `WPP_*` passam a impressão de controlar a sessão, mas não são consumidos pela versão ativa.
5. `RECOVER_ON_START=true` não ativa a recuperação da BaseBots, porque a chave é ignorada. A `main` possui mecanismos legados próprios de retomada e não lidas.
6. `EXTERNAL_LABELS_TRIGGER_HANDOFF=false` não desativa handoff por etiquetas; a chave é ignorada.
7. `LOG_DIRECTORY` e `LOG_RECENT_LIMIT` não criam persistência do logger atual.

## Segurança

O `.env` real não deve ser versionado. Chave de dados, senha de backup, senha VNC e senha do painel precisam permanecer apenas na VPS. A chave de criptografia não deve ser trocada sem plano de migração do SQLite existente.
