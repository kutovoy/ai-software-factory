#!/usr/bin/env bash
# Fast CI gate: no Docker, no Postgres, no Temporal, no model credentials.
#
#   bun run ci
#
# Docker-backed tests (runner integration, compose smoke) are opt-in:
#   RUN_SLOW=1 bun test
#   docker compose up -d && bash scripts/smoke.sh
set -euo pipefail
cd "$(dirname "$0")/.."

bun run typecheck
bun test
bun run factory validate factories/example
bun run factory validate factories/example-lights-off
bun run factory export factories/example --check
bun run factory export factories/example-lights-off --check

# The fake harness path must stay credential-free: no OPENAI_* leaks into the test env.
if [ -n "${OPENAI_API_KEY:-}" ] && [ "${CI_STRICT:-0}" = "1" ]; then
  echo "warning: OPENAI_API_KEY is set; unit tests do not use it" >&2
fi
