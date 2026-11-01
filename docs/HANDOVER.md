# Handover

State as of 2026-11-01. Everything below is committed and tagged. Public-release prep: `README.md`, `LICENSE`
(MIT, © Nick Kutovyy), `NOTICE` (attribution request), `SECURITY.md`, `CONTRIBUTING.md`.

## What exists

| Layer | Location | Notes |
|---|---|---|
| Definition schema + CLI | `packages/core`, `packages/cli` | `factory validate/export/import/diff/fmt/version`, canonical YAML, semantic diff, git version pinning |
| Harness adapters | `packages/adapters` | canonical `FactoryEvent`, `FakeAdapter`, opencode adapter (installed v2 API, v1-tolerant) |
| Runners | `packages/runners` | Docker + local backends; harness runs *inside* the sandbox; secret boundary |
| Orchestration | `packages/orchestration` | Temporal: `RunWorkflow`, `FactoryWorkflow`, `StageWorkflow`, `ScoringWorkflow`, `BenchmarkWorkflow`, `ImprovementWorkflow`, `CanaryWorkflow`, `MergeQueueWorkflow` |
| Code forges | `packages/forge` | `CodeForge` contract, fake + GitHub (token by ref, dry-run, offline contract tests) |
| Merge queue | `packages/merge` | serialized merge train, bisect on red, single-commit revert, manual revert |
| Evals | `packages/evals` | scorers (deterministic + judge), calibration, benchmarks, Pareto, self-improvement, lessons |
| API | `apps/api` | path-versioned under `/api/v1` (ADR-030); OpenAPI 3.1 at `GET /api/v1/openapi.json`; runs/SSE, permissions, chat, inference proxy, factories, work items, gates, autonomy, scores, benchmarks, proposals, canary, merge queue, integrations, webhooks |
| Web console | `apps/web` | full nav parity; chat/runs/inbox/work-items/factory pages/benchmarks/self-improvement/settings |
| Examples | `factories/example`, `factories/example-lights-off` | lights-on (spec/plan/PR human) vs canary authority |

## Run it

```bash
docker compose up -d --build      # postgres + temporal + api + worker + web
bash scripts/smoke.sh             # full credential-free smoke (16 sections)
cd apps/web && bunx playwright test   # 23 E2E flows
bun run ci                        # typecheck + unit/integration-off + factory validation

# the API surface: one version prefix, /health stays unversioned
curl -s localhost:8080/health                 # liveness probe
curl -s localhost:8080/api/v1/health          # same body, versioned
curl -s localhost:8080/api/v1/openapi.json    # the contract (Swagger UI / Postman)
curl -s localhost:8080/api/v1/runs            # resources are versioned only
```

Integration suites (need compose up) default to the separate `factory_test` database
(created by `scripts/postgres-init.sql`; on an existing volume run
`create database factory_test owner factory` once):
```bash
TEMPORAL_ADDRESS=localhost:7233 RUN_INTEGRATION=1 bun test <file>
# DATABASE_URL=postgres://... overrides the factory_test default.
```
`scripts/smoke.sh` prints its target database, pauses the nightly schedule it syncs and
deletes the throwaway secret it registers. `bash scripts/reset-dev.sh --yes` clears
smoke/e2e/demo rows explicitly.

## Point it at your own model

The sandbox never sees provider credentials (ADR-011). Set in `.env`:

```
OPENAI_BASE_URL=http://host.docker.internal:4000/v1   # your LiteLLM
OPENAI_API_KEY=sk-...                                 # provider key, stays in api/worker
FACTORY_MODEL=best_llm                                # foreman/spec/implement
FACTORY_SMALL_MODEL=best_llm                          # triage/verify
FACTORY_REVIEW_MODEL=best_llm                         # review
```

The example definitions declare `model: env:FACTORY_*` (ADR-028), so the concrete model is
configuration. `factory validate` prints every resolved model; an unset variable is a warning,
and starting a run with it is refused with `model_unresolved`.

The API mints a per-run `rsk_…` token, injects the real key only outside the sandbox, and revokes it at run
end. Harnesses receive `OPENAI_BASE_URL=<proxy>/v1` + the run token.

## Real GitHub

Set `GITHUB_TOKEN` (fine-grained PAT: repo, pull_request, checks) and enable the integration via
`POST /api/v1/integrations/github` or the Settings page; configure the webhook URL + secret name. `GITHUB_DRY_RUN=1`
lets you validate wiring without touching a repo. GitHub delivers to
`${WEBHOOK_PUBLIC_URL}/api/v1/webhooks/github` (the Settings page shows the exact URL).

## Known gaps / next

1. **Phase 6**: users/roles, remote runners, Temporal Cloud, per-tenant credential isolation.
2. **Local runner isolation**: `local-process` backend has no `sandbox-exec` jail yet.
3. **Live GitHub path**: implemented and contract-tested, not exercised against a real repo.
4. **Recorded-tool-response replay**: benchmarks use hermetic sandboxes, not recorded side effects.
5. **One intermittent test failure** observed once in Phase 5b; three reruns green, not reproduced.
6. **Promotion** merges the definition repo but does not rewrite the local checkout; `runs/canary/` not GC'd.

## Version tags

`factory-v0` (definition schema) · `phase-2a` (runtime) · `phase-2b` (console) · `phase-3a` (loop) ·
`phase-3b` (GitHub + merge queue) · `phase-4a` (scoring) · `phase-4b` (benchmarks) · `phase-5` (self-improvement) ·
`harden-runtime` · `secrets-mcp` · `api-v1-help` · `help-center` · `live-api-explorer` · `api-explorer-parity` ·
`fix-ui-audit` · `fix-run-failures` · `run-actions` · `readiness-hello-nextjs` · `console-ops` · `forgejo`.

## Latest state (2026-11-01)

- **Readiness PASS**: `hello-nextjs` (six agents, all gates `agent`, `auto_on_green`, audited autonomy override)
  took `wi_01M6B5097TGHK0KKZQN9BB3C4G` to `done` with zero human decisions and a merged PR containing the five
  `site/` files. Fixes: prompt delivery, factory-agent identity, patch capture for untracked files, downstream
  patch application, work-item retry, contextual run actions.
- **Local forge**: Forgejo at `http://localhost:3000/extras/forgejo/`, enabled by default, proxied by the console
  with single-user header auth. Bootstrap: `bash scripts/forgejo-bootstrap.sh` (admin, token to `.env`, org/repo).
  The forge client speaks Gitea's dialect; PR URLs resolve. SSH/websockets and multi-user OIDC are deferred.
- **Console**: auto-refresh (15s, off on help), operational dashboard (state/work/runs/deliverables), persisted
  factory selection, work-items board with status filters and timestamps.
- **API**: everything under `/api/v1`, OpenAPI 3.1 at `/api/v1/openapi.json`, live Swagger UI at `/help/api`.

### Run it with a real model and forge

```bash
cp .env.example .env
# OPENAI_BASE_URL / OPENAI_API_KEY, FACTORY_MODEL / FACTORY_SMALL_MODEL / FACTORY_REVIEW_MODEL
docker compose up -d --build
bash scripts/forgejo-bootstrap.sh   # provisions the local forge and writes GITHUB_TOKEN to .env
```

Then open http://localhost:3000, pick a factory, and create a work item. `hello-nextjs` is lights-off.

### Known gaps

1. **Phase 6b**: console auth/users; per-user forge organizations via OIDC (Keycloak optional).
2. **Agent-gate verdicts**: gates approve on run `ok`; a textual FAIL is advisory. A structured verdict channel is
   the next correctness fix for lights-off.
3. Remote runners, Temporal Cloud, multi-tenant isolation.
4. Forge SSH/websockets; dedicated proxy if pushes outgrow the console proxy.
5. Benchmarks are hermetic replays, not recorded-tool-response replays.

## Specs

13 living capabilities in `openspec/specs/`: factory-definition, run-lifecycle, harness-adapter, runner-protocol,
event-stream, web-console, factory-loop, measurement, benchmarks, self-improvement, code-forge, merge-queue,
automations.
