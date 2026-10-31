# Tasks

## 1. Model references (`packages/core`, `packages/cli`)

- [x] 1.1 `model` may be `env:NAME`; validate the name (`invalid_value`); helper `resolveModelRef()`
- [x] 1.2 Resolved config reports `{ref, value, source: literal|env}`; unset env → warning
      `model_env_unresolved` (non-fatal)
- [x] 1.3 Run creation refuses an unresolved model with `model_unresolved` (never send `env:…` upstream)
- [x] 1.4 `factory validate` prints resolved models
- [x] 1.5 Update `factories/example` + `example-lights-off`: `env:FACTORY_MODEL` (foreman/spec/implement),
      `env:FACTORY_SMALL_MODEL` (triage/verify), `env:FACTORY_REVIEW_MODEL` (review); canonical snapshots
- [x] 1.6 `.env` + `.env.example`: `FACTORY_MODEL`, `FACTORY_SMALL_MODEL`, `FACTORY_REVIEW_MODEL`
- [x] 1.7 Chat default model comes from the resolved factory default, not a hardcoded literal
- [x] 1.8 Tests: literal, resolved, unset warning, run refusal, invalid name

## 2. UI defects (`apps/web`)

- [x] 2.1 One heading source (alias → directory name) on all factory pages; fix Self-improvement/Benchmarks
- [x] 2.2 Distinct `name`/`alias` for `factories/example-lights-off` ("Example — lights off")
- [x] 2.3 Definition page: wrap/scroll long config values; no horizontal overflow at 1280px
- [x] 2.4 Gates attestation copy: when not required, say why (human gates remain); never claim a matching
      attestation when the suite row says "no attestation"
- [x] 2.5 MCP count pluralisation (`1 server`)
- [x] 2.6 Self-improvement: "Canary authority is enabled" when configured; active rollout reported separately
- [x] 2.7 Secrets page: show factory per reference; no duplicate-looking rows
- [x] 2.8 Playwright assertions for 2.1–2.7 in the existing specs

## 3. Dev-data hygiene

- [x] 3.1 Smoke pauses the cron schedules it syncs and deletes the secret it registers (no nightly items)
- [x] 3.2 `scripts/reset-dev.sh` — explicit cleanup of smoke/e2e/demo rows (refuses without `--yes`)
- [x] 3.3 Integration tests default to `factory_test`; compose creates it (init SQL); docs updated
- [x] 3.4 `scripts/smoke.sh` states which database it targets

## 4. Wrap-up

- [x] 4.1 Re-run the UI audit (33 routes): zero console errors, zero overflow
- [x] 4.2 `bun run ci`, smoke, Playwright green
- [x] 4.3 STATUS + ADR-028 (model refs are env-resolved) + ADR-029 (tests use a separate database)
- [x] 4.4 `openspec validate fix-ui-audit-and-model-config`
