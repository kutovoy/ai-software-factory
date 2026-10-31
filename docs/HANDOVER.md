# Handover

State as of 2026-10-29. Everything below is committed and tagged.

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
| API | `apps/api` | runs/SSE, permissions, chat, inference proxy, factories, work items, gates, autonomy, scores, benchmarks, proposals, canary, merge queue, integrations, webhooks |
| Web console | `apps/web` | full nav parity; chat/runs/inbox/work-items/factory pages/benchmarks/self-improvement/settings |
| Examples | `factories/example`, `factories/example-lights-off` | lights-on (spec/plan/PR human) vs canary authority |

## Run it

```bash
docker compose up -d --build      # postgres + temporal + api + worker + web
bash scripts/smoke.sh             # full credential-free smoke (16 sections)
cd apps/web && bunx playwright test   # 23 E2E flows
bun run ci                        # typecheck + unit/integration-off + factory validation
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
`POST /integrations/github` or the Settings page; configure the webhook URL + secret name. `GITHUB_DRY_RUN=1`
lets you validate wiring without touching a repo.

## Known gaps / next

1. **Phase 6**: users/roles, remote runners, Temporal Cloud, per-tenant credential isolation.
2. **Local runner isolation**: `local-process` backend has no `sandbox-exec` jail yet.
3. **Live GitHub path**: implemented and contract-tested, not exercised against a real repo.
4. **Recorded-tool-response replay**: benchmarks use hermetic sandboxes, not recorded side effects.
5. **One intermittent test failure** observed once in Phase 5b; three reruns green, not reproduced.
6. **Promotion** merges the definition repo but does not rewrite the local checkout; `runs/canary/` not GC'd.

## Version tags

`factory-v0` (definition schema) · `phase-2a` (runtime) · `phase-2b` (console) · `phase-3a` (loop) ·
`phase-3b` (GitHub + merge queue) · `phase-4a` (scoring) · `phase-4b` (benchmarks) · `phase-5` (self-improvement).

## Specs

13 living capabilities in `openspec/specs/`: factory-definition, run-lifecycle, harness-adapter, runner-protocol,
event-stream, web-console, factory-loop, measurement, benchmarks, self-improvement, code-forge, merge-queue,
automations.
