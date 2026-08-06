#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DOMAIN="${1:-}"

if [[ -z "$DOMAIN" ]]; then
  echo "Uso: bash scripts/deploy-vps-ready.sh whatsapp.seudominio.com.br" >&2
  exit 1
fi

cd "$ROOT_DIR"
NODE_MAJOR="$(node -p "Number(process.versions.node.split('.')[0])" 2>/dev/null || echo 0)"
if (( NODE_MAJOR < 22 || NODE_MAJOR >= 25 )); then
  echo "[deploy] use Node.js 22 a 24. Atual: $(node --version 2>/dev/null || echo ausente)" >&2
  exit 1
fi

node scripts/prepare-vps-env.js "$DOMAIN"

# shellcheck disable=SC1091
source "$ROOT_DIR/scripts/load-dotenv.sh"
load_dotenv_file "$ROOT_DIR/.env"

if [[ -d tokens || -f data/personalize.sqlite || -f data/sessions.json ]]; then
  echo "[deploy] criando backup criptografado do estado existente"
  bash scripts/backup-vps-state.sh
fi

sudo bash scripts/install-session-access-ubuntu.sh
export PUPPETEER_SKIP_DOWNLOAD=true
export PUPPETEER_CHROME_SKIP_DOWNLOAD=true
export PUPPETEER_CHROME_HEADLESS_SHELL_SKIP_DOWNLOAD=true
npm ci
npm run storage:init
npm run storage:seal-legacy
npm test
npm run vps:preflight

sudo bash scripts/configure-nginx-access.sh \
  "$DOMAIN" \
  "${SESSION_ACCESS_HTTP_USER:-personalize}" \
  "${SESSION_ACCESS_HTTP_PASSWORD:-2580}"

pm2 startOrReload ecosystem.config.cjs
pm2 save

echo
echo "[deploy] concluído"
echo "[deploy] WhatsApp Web: https://$DOMAIN/vnc.html?autoconnect=true&resize=scale"
echo "[deploy] usuário: ${SESSION_ACCESS_HTTP_USER:-personalize}"
echo "[deploy] senha configurada: 2580"
echo "[deploy] confira: pm2 logs personalize-wppconnect --lines 100"
