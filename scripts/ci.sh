#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

bun run typecheck
bun test
bun run factory validate factories/example
bun run factory validate factories/example-lights-off
bun run factory export factories/example --check
bun run factory export factories/example-lights-off --check
