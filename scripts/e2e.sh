#!/usr/bin/env bash
# End-to-end gate: compose stack (web + api + worker + postgres + temporal) → smoke →
# Playwright chromium against the console.
#
#   bash scripts/e2e.sh
#
# Environment:
#   E2E_BASE_URL            default http://localhost:3000
#   PLAYWRIGHT_SKIP_INSTALL 1 to reuse an already-installed chromium
#
# `bun run ci` stays Docker-free; this script is the Docker-backed half of CI
# (.github/workflows/ci.yml job `e2e`).
set -euo pipefail
cd "$(dirname "$0")/.."

log() { printf '[e2e] %s\n' "$*"; }

log "bringing up the compose stack (build included)"
docker compose up -d --build

# smoke.sh waits for /health, applies migrations, runs a fake-harness chat run, checks
# SSE + permission approval + proxy + replay. It also asserts the web shell renders.
log "running scripts/smoke.sh"
bash scripts/smoke.sh

if [ "${PLAYWRIGHT_SKIP_INSTALL:-0}" != "1" ]; then
  log "installing playwright chromium"
  if [ "${CI:-0}" = "1" ]; then
    (cd apps/web && bunx playwright install --with-deps chromium)
  else
    (cd apps/web && bunx playwright install chromium)
  fi
fi

log "running playwright (baseURL=${E2E_BASE_URL:-http://localhost:3000})"
(cd apps/web && bunx playwright test)

log "E2E PASSED"
