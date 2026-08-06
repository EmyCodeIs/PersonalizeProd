#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT_DIR/.env}"
LOCK_FILE="$ROOT_DIR/data/session-access/start.lock"
mkdir -p "$(dirname "$LOCK_FILE")"

# shellcheck disable=SC1091
source "$ROOT_DIR/scripts/load-dotenv.sh"
load_dotenv_file "$ENV_FILE"

export DISPLAY="${SESSION_DISPLAY:-:1}"
export PUPPETEER_SKIP_DOWNLOAD=true
export PUPPETEER_CHROME_SKIP_DOWNLOAD=true
export PUPPETEER_CHROME_HEADLESS_SHELL_SKIP_DOWNLOAD=true

if [[ -z "${PUPPETEER_EXECUTABLE_PATH:-}" ]]; then
  for candidate in google-chrome-stable google-chrome chromium chromium-browser; do
    if command -v "$candidate" >/dev/null 2>&1; then
      export PUPPETEER_EXECUTABLE_PATH="$(command -v "$candidate")"
      break
    fi
  done
fi

if [[ -z "${PUPPETEER_EXECUTABLE_PATH:-}" || ! -x "$PUPPETEER_EXECUTABLE_PATH" ]]; then
  echo "[vps] Google Chrome/Chromium do sistema não encontrado." >&2
  exit 1
fi

cd "$ROOT_DIR"
node scripts/cleanup-stale-browser-profile.js

if ! bash "$ROOT_DIR/scripts/session-access-health.sh" >/dev/null 2>&1; then
  flock -w 30 "$LOCK_FILE" bash "$ROOT_DIR/scripts/start-session-access.sh"
fi
bash "$ROOT_DIR/scripts/session-access-health.sh"

echo "[vps] navegador: $PUPPETEER_EXECUTABLE_PATH"
echo "[vps] iniciando WPPConnect dentro do desktop compartilhado $DISPLAY"
echo "[vps] o vendedor verá e controlará exatamente o Chrome aberto pelo bot"
echo

exec node src/start-with-required-labels.js
