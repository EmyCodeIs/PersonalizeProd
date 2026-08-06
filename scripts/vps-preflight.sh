#!/usr/bin/env bash
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT_DIR/.env}"

errors=0
warnings=0

ok() { echo "[preflight] OK: $*"; }
warn() { echo "[preflight] AVISO: $*"; warnings=$((warnings + 1)); }
fail() { echo "[preflight] FALHA: $*" >&2; errors=$((errors + 1)); }

is_true() {
  case "${1,,}" in
    1|true|yes|sim|on) return 0 ;;
    *) return 1 ;;
  esac
}

is_false() {
  case "${1,,}" in
    0|false|no|nao|não|off|"") return 0 ;;
    *) return 1 ;;
  esac
}

need_cmd() {
  if command -v "$1" >/dev/null 2>&1; then
    ok "comando encontrado: $1"
  else
    fail "comando obrigatório ausente: $1"
  fi
}

if [[ ! -f "$ENV_FILE" ]]; then
  fail "arquivo .env ausente em $ENV_FILE"
fi

if ! command -v node >/dev/null 2>&1; then
  fail "Node.js não encontrado"
  echo "[preflight] resultado: $errors falha(s), $warnings aviso(s)"
  exit 1
fi

if [[ -f "$ENV_FILE" ]]; then
  # shellcheck disable=SC1091
  source "$ROOT_DIR/scripts/load-dotenv.sh"
  if ! load_dotenv_file "$ENV_FILE"; then
    fail "não foi possível carregar o .env"
  fi
fi

need_cmd node
need_cmd npm
need_cmd Xvfb
need_cmd openbox-session
need_cmd x11vnc
need_cmd curl
need_cmd ss
need_cmd flock
need_cmd nginx
need_cmd htpasswd

if command -v novnc_proxy >/dev/null 2>&1 \
  || command -v websockify >/dev/null 2>&1 \
  || [[ -x "${SESSION_NOVNC_WEB:-/usr/share/novnc}/utils/novnc_proxy" ]]; then
  ok "noVNC/websockify encontrado"
else
  fail "novnc_proxy ou websockify não encontrado"
fi

BROWSER_BIN=""
for candidate in google-chrome-stable google-chrome chromium chromium-browser; do
  if command -v "$candidate" >/dev/null 2>&1; then
    BROWSER_BIN="$(command -v "$candidate")"
    break
  fi
done

if [[ -n "$BROWSER_BIN" ]]; then
  export PUPPETEER_EXECUTABLE_PATH="${PUPPETEER_EXECUTABLE_PATH:-$BROWSER_BIN}"
  ok "navegador encontrado: $PUPPETEER_EXECUTABLE_PATH"
else
  fail "Google Chrome/Chromium não encontrado"
fi


if [[ -f "$ROOT_DIR/.puppeteerrc.cjs" ]]; then
  ok "Puppeteer configurado para usar navegador do sistema sem download próprio"
else
  fail ".puppeteerrc.cjs ausente; npm ci pode baixar navegadores duplicados"
fi

for flag in CONNECTION_SUPERVISOR_ENABLED MESSAGE_INBOX_ENABLED CONVERSATION_CURSOR_ENABLED OUTBOUND_LEDGER_ENABLED LEAD_PANEL_ENABLED; do
  value="${!flag:-}"
  if [[ -n "$value" ]]; then
    ok "flag operacional explícita: $flag=$value"
  else
    fail "flag operacional ausente no .env: $flag"
  fi
done

NODE_MAJOR="$(node -p "Number(process.versions.node.split('.')[0])" 2>/dev/null || echo 0)"
if (( NODE_MAJOR >= 22 && NODE_MAJOR < 25 )); then
  ok "Node.js compatível: $(node --version)"
else
  fail "Node.js incompatível: $(node --version 2>/dev/null || echo desconhecido); esperado 22 a 24"
fi


if [[ "${STORAGE_DRIVER:-}" == "sqlite" ]]; then
  if (( NODE_MAJOR >= 22 )); then
    ok "SQLite embutido disponível no Node.js"
  else
    fail "STORAGE_DRIVER=sqlite exige Node.js 22 ou superior"
  fi
  if [[ -n "${DATA_ENCRYPTION_KEY:-}" ]]; then
    ok "chave de criptografia configurada"
  else
    fail "DATA_ENCRYPTION_KEY ausente"
  fi
else
  fail "STORAGE_DRIVER precisa ser sqlite na produção"
fi

CACHE_DIR="${BROWSER_CACHE_DIR:-data/browser-cache}"
if [[ "$CACHE_DIR" == tokens* || "$CACHE_DIR" == */tokens/* ]]; then
  fail "BROWSER_CACHE_DIR não pode ficar dentro de tokens/"
else
  ok "cache pesado separado de tokens/: $CACHE_DIR"
fi

if [[ "${MOCK_MODE:-false}" == "false" ]]; then
  ok "MOCK_MODE desativado"
else
  fail "MOCK_MODE precisa ser false na VPS"
fi

if [[ "${WPP_HEADLESS:-false}" == "false" ]]; then
  ok "Chrome visível habilitado para o desktop remoto"
else
  fail "WPP_HEADLESS precisa ser false para o vendedor visualizar o Chrome"
fi

if is_false "${ENABLE_TEST_COMMANDS:-false}"; then
  ok "comandos de teste desativados"
else
  fail "ENABLE_TEST_COMMANDS precisa ser false na produção"
fi

if [[ -z "${ALLOWED_CLIENT_NUMBERS:-}" && -z "${ALLOWED_CHAT_IDS:-}" ]]; then
  ok "whitelist de teste removida"
else
  fail "ALLOWED_CLIENT_NUMBERS e ALLOWED_CHAT_IDS precisam ficar vazios na produção"
fi

ACCESS_HOST="${SESSION_ACCESS_HOST:-127.0.0.1}"
ACCESS_PORT="${SESSION_ACCESS_PORT:-6080}"
VNC_PORT="${SESSION_VNC_PORT:-5901}"

if [[ "$ACCESS_HOST" == "127.0.0.1" || "$ACCESS_HOST" == "localhost" ]]; then
  ok "noVNC restrito ao loopback: $ACCESS_HOST"
else
  fail "SESSION_ACCESS_HOST deve ser 127.0.0.1"
fi

if [[ "$ACCESS_PORT" == "$VNC_PORT" ]]; then
  fail "SESSION_ACCESS_PORT e SESSION_VNC_PORT não podem ser iguais"
else
  ok "portas internas separadas: noVNC=$ACCESS_PORT VNC=$VNC_PORT"
fi

ACCESS_PASSWORD="${SESSION_ACCESS_PASSWORD:-}"
case "$ACCESS_PASSWORD" in
  ""|troque-esta-senha|COLOQUE_UMA_SENHA_FORTE_AQUI)
    fail "SESSION_ACCESS_PASSWORD ausente"
    ;;
  *)
    if (( ${#ACCESS_PASSWORD} < 8 )); then
      if is_true "${ALLOW_WEAK_SESSION_PASSWORD:-false}"; then
        warn "senha VNC curta autorizada explicitamente"
      else
        fail "SESSION_ACCESS_PASSWORD precisa ter pelo menos 8 caracteres"
      fi
    else
      ok "senha VNC configurada"
    fi
    ;;
esac

PUBLIC_URL="${SESSION_ACCESS_PUBLIC_URL:-}"
if [[ "$PUBLIC_URL" =~ ^https:// ]] && [[ "$PUBLIC_URL" != *"seudominio"* ]]; then
  ok "URL pública HTTPS configurada"
else
  fail "SESSION_ACCESS_PUBLIC_URL precisa usar o domínio real com https://"
fi

if is_true "${LABEL_MAINTENANCE_AUTO_REMOVE_DUPLICATES:-false}"; then
  warn "remoção automática de etiquetas duplicadas está ativada"
else
  ok "duplicatas serão apenas auditadas"
fi

if is_true "${ENABLE_UNREAD_BOOTSTRAP:-false}"; then
  warn "recuperação de não lidas está ativada; use somente após a primeira conferência"
else
  ok "recuperação de não lidas desativada para a primeira conexão"
fi

if [[ "$(id -u)" == "0" ]]; then
  warn "processo será executado como root; o Chrome usará --no-sandbox. Prefira um usuário Linux dedicado"
else
  ok "processo será executado sem privilégios de root"
fi

NOVNC_WEB="${SESSION_NOVNC_WEB:-/usr/share/novnc}"
if [[ -f "$NOVNC_WEB/vnc.html" ]]; then
  ok "interface noVNC encontrada em $NOVNC_WEB"
else
  fail "vnc.html não encontrado em $NOVNC_WEB"
fi

mkdir -p "$ROOT_DIR/data" "$ROOT_DIR/tokens" 2>/dev/null || fail "não foi possível criar data/ e tokens/"
for directory in "$ROOT_DIR/data" "$ROOT_DIR/tokens"; do
  if [[ -d "$directory" && -w "$directory" ]]; then
    ok "diretório persistente gravável: $directory"
  else
    fail "diretório sem permissão de escrita: $directory"
  fi
done

if [[ -d "$ROOT_DIR/assets" ]]; then
  ok "diretório assets encontrado"
else
  fail "diretório assets ausente"
fi

for script in \
  load-dotenv.sh \
  start-session-access.sh \
  stop-session-access.sh \
  session-access-health.sh \
  watch-session-access.sh \
  start-vps-whatsapp.sh \
  install-session-access-ubuntu.sh \
  configure-nginx-access.sh \
  deploy-vps-ready.sh \
  backup-vps-state.sh \
  vps-preflight.sh; do
  if bash -n "$ROOT_DIR/scripts/$script"; then
    ok "sintaxe Bash: $script"
  else
    fail "erro de sintaxe Bash: $script"
  fi
done

if command -v free >/dev/null 2>&1; then
  TOTAL_RAM_MB="$(free -m | awk '/^Mem:/ {print $2}')"
  if [[ -n "$TOTAL_RAM_MB" ]] && (( TOTAL_RAM_MB < 2000 )); then
    warn "VPS possui ${TOTAL_RAM_MB} MB de RAM; Chrome e bot podem disputar memória"
  else
    ok "memória total detectada: ${TOTAL_RAM_MB:-desconhecida} MB"
  fi
fi

if command -v df >/dev/null 2>&1; then
  AVAILABLE_KB="$(df -Pk "$ROOT_DIR" | awk 'NR==2 {print $4}')"
  if [[ -n "$AVAILABLE_KB" ]] && (( AVAILABLE_KB < 2097152 )); then
    warn "menos de 2 GB livres no disco do projeto"
  else
    ok "espaço livre em disco conferido"
  fi
fi

if [[ "${VPS_PREFLIGHT_SKIP_TESTS:-false}" == "true" ]]; then
  warn "testes do Node foram pulados por VPS_PREFLIGHT_SKIP_TESTS=true"
else
  echo "[preflight] executando npm test..."
  if (cd "$ROOT_DIR" && npm test); then
    ok "testes do projeto aprovados"
  else
    fail "npm test falhou"
  fi
fi

echo "[preflight] resultado: $errors falha(s), $warnings aviso(s)"
if (( errors > 0 )); then
  exit 1
fi