# Design

## Context

Phase 1 ships `packages/core` (definition schema, loader, gates, diff, version) and `packages/cli`.
ADR-001 says Temporal from day one; ADR-002 says chat always goes adapter → runner. This change builds
exactly that runtime, headless, so the UI in 2b has a stable contract.

Constraints: Bun + TypeScript, macOS dev host, Docker available, no model credentials in CI.

## Goals / Non-Goals

**Goals:**
- One `RunWorkflow` per run; survives worker restart; cancellable; records terminal state.
- A canonical `FactoryEvent` stream every consumer (SSE, JSONL, UI, scorers later) shares.
- A harness adapter that can wrap opencode today and anything else later, with capability flags.
- A runner that leases a sandbox, hosts the harness *inside* it, and returns artifacts.
- Full path exercisable in CI with a fake harness — zero network, zero credentials.

**Non-Goals:**
- No factory stages/foreman/gates (Phase 3).
- No web UI (Phase 2b).
- No remote runners (Phase 6).
- No scorers/benchmarks (Phase 4).
- No multi-tenant auth.

## Decisions

1. **Harness runs inside the runner.** `opencode serve` starts in the run container; the adapter connects
   to its mapped port over HTTP+SSE. Tool calls therefore execute in the sandbox by construction, and the
   API never needs shell access to the host.
2. **Temporal is the execution truth.** Workflow state + activity retries own lifecycle. Postgres holds a
   *read model* (`runs`, `run_steps`, `events`) written by activities; losing Postgres never loses a run.
3. **Event log is append-only with monotonic `seq` per run.** Activities append JSONL to the run directory
   and insert into Postgres in the same step. SSE replays from `Last-Event-ID`.
4. **Canonical events, AG-UI-shaped.** Adapters translate harness-specific payloads into `FactoryEvent`;
   unknown harness features degrade via capability flags rather than failing.
5. **Permissions are a round-trip.** `permission.requested` carries a `requestId`; the API exposes
   `POST /runs/:id/permissions/:requestId`; adapters map that to the harness's native mechanism.
   Static-permission harnesses advertise `capabilities.permissions = "static"`.
6. **Runner protocol is transport-agnostic.** `RunnerBackend` interface; `docker` implementation now,
   `remote` later. Every call idempotent, keyed by `runnerId`.
7. **Artifacts by reference.** Patches/logs/screenshots go to the run directory (later object store);
   Postgres stores paths + hashes, never blobs.
8. **Fake harness first.** `FakeAdapter` emits a deterministic scripted event sequence, so `smoke.sh` and
   adapter contract tests run in CI without a model.

## Risks / Trade-offs

- **Docker-in-CI on macOS is slow.** Mitigation: fake harness path needs no container; the docker path is
  a separate integration test tagged `slow`.
- **Port mapping + SSE through Docker.** Mitigation: bind harness port to an ephemeral host port; adapter
  uses `127.0.0.1:<port>`; retry with backoff until `/health` responds.
- **Temporal worker restarts during a run.** Mitigation: activities idempotent (`runId + stepId` keys);
  workflow uses `continueAsNew` only if history grows beyond a threshold.
- **Event ordering across activities.** Mitigation: single writer per run (the workflow's event activity)
  or a per-run advisory lock when appending.
