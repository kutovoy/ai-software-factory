# Tasks

## 1. Orchestration package (`packages/orchestration`)

- [x] 1.1 `client.ts` — Temporal connection, `startRun`, `cancelRun`, namespace from env
- [x] 1.2 `workflows/run.ts` — `RunWorkflow`: start harness → stream → terminal state; signals for cancel
- [x] 1.3 `activities/runner.ts` — lease/exec/artifacts/kill activities, idempotent by `runId+stepId`
- [x] 1.4 `activities/persist.ts` — write run/step/event rows + append JSONL (single writer per run)
- [x] 1.5 `worker.ts` — worker entrypoint registering workflow + activities
- [x] 1.6 Retry policy + timeouts documented in code comments

## 2. Adapters (`packages/adapters`)

- [x] 2.1 `events.ts` — canonical `FactoryEvent` union + Zod schemas + `seq` assignment
- [x] 2.2 `adapter.ts` — `HarnessAdapter` interface + `AdapterCapabilities`
- [x] 2.3 `fake.ts` — deterministic scripted adapter (message deltas, tool calls, permission request, patch, usage)
- [x] 2.4 `opencode.ts` — connect to `opencode serve`: `POST /session`, `prompt_async`, `/event` SSE, `/abort`,
  `/session/:id/permissions/:id`, `/session/:id/diff`, `/agent`
- [x] 2.5 Readiness probe + `harness_unreachable` error mapping
- [x] 2.6 Contract tests: same scripted scenario runs through fake + recorded opencode fixtures, producing identical canonical event shapes

## 3. Runners (`packages/runners`)

- [x] 3.1 `protocol.ts` — `RunnerBackend` interface (`lease|exec|heartbeat|artifacts|kill`)
- [x] 3.2 `docker.ts` — container per run: checkout at pinned commit, mount workspace, start `opencode serve`,
  map port, return `harnessUrl`; stop/remove on kill
- [x] 3.3 `docker.ts` — `exec` streams stdout/stderr/exit code; timeout + kill on cancel
- [x] 3.4 Secret injection: allowlist only, never inference creds; scrub from logs
- [x] 3.5 `local.ts` — process-based fallback (no Docker) for fast tests, same interface
- [x] 3.6 Integration test tagged `slow`: lease → exec `echo` → artifacts → kill

## 4. API (`apps/api`)

- [x] 4.1 Bun + Hono server, `/health`, env config, structured logging
- [x] 4.2 `POST /runs` — validate factory, pin `definitionCommit`, start workflow
- [x] 4.3 `GET /runs`, `GET /runs/:id` — from Postgres read model
- [x] 4.4 `GET /runs/:id/events` — SSE with `Last-Event-ID` replay + live tail + terminal close
- [x] 4.5 `POST /runs/:id/cancel`, `POST /runs/:id/permissions/:requestId`
- [x] 4.6 `POST /chat` — sugar over `POST /runs` for a human-initiated prompt (same code path)
- [x] 4.7 Error envelope `{code, message, details?}` consistent with Phase 1 codes
- [x] 4.8 **Inference proxy** — OpenAI-compatible passthrough at `/v1/*`: per-run bearer token, injects the
  real provider credential, model allowlist per run, streaming passthrough, records attempts, token revoked
  at run end. Runner receives `OPENAI_BASE_URL=<proxy>/v1` + `OPENAI_API_KEY=<runToken>` only.

## 5. Persistence

- [x] 5.1 `packages/core/migrations/002_runs_events.sql` — `runs`, `run_steps`, `events` (+ indexes on run/seq)
- [x] 5.2 Migration runner (`scripts/migrate.ts`) using Bun SQL
- [x] 5.3 Run directory layout `runs/<runId>/{events.jsonl,patch.diff,artifacts/}` documented

## 6. Compose & smoke

- [x] 6.1 `compose.yaml` — postgres, temporal (dev server), api, worker; healthchecks; volumes
- [x] 6.2 `.env.example` — `DATABASE_URL`, `TEMPORAL_ADDRESS`, `OPENAI_BASE_URL`, `OPENAI_API_KEY`, `FACTORY_ROOT`
- [x] 6.3 `scripts/smoke.sh` — wait for health → create fake-harness run → assert ≥3 SSE events incl. terminal → approve permission
- [x] 6.4 `scripts/ci.sh` extended: typecheck + unit + adapter contract tests (no docker), `slow` tests opt-in
- [x] 6.5 Smoke asserts the proxy path: run's env has no provider key; a stub model call through the proxy succeeds

## 7. Docs & wrap-up

- [x] 7.1 `packages/adapters/README.md` — adapter contract + how to add a harness (with capability matrix)
- [x] 7.2 `packages/runners/README.md` — runner protocol + docker backend notes + secret boundary
- [x] 7.3 `docs/STATUS.md` updated (2a complete, 2b next)
- [x] 7.4 ADR-009 (harness runs inside the runner) and ADR-010 (Postgres as derived read model)
- [x] 7.5 `openspec validate add-run-lifecycle-and-adapters` passes
