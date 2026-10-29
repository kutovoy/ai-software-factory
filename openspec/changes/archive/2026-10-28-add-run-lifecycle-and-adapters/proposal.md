# Proposal

## Why

Phase 1 gave us a versioned factory definition, but nothing executes yet. Phase 2 must prove the central
claim of this project: **the web UI is the harness front-end, and tool execution happens on runners** —
not in the web process, not in a terminal.

We split Phase 2 into 2a (headless core) and 2b (web UI). 2a delivers the runtime contract that 2b renders:
a durable run orchestrated by Temporal, a harness adapter that streams canonical events, and a runner that
leases a sandbox and hosts the harness.

## What Changes

- Add `packages/orchestration`: Temporal workflows/activities (`RunWorkflow`), worker entrypoint, client.
- Add `packages/adapters`: canonical `FactoryEvent` union, `HarnessAdapter` interface, capability flags,
  and an **opencode adapter** that talks to `opencode serve` (HTTP + SSE) running inside a runner.
- Add `packages/runners`: runner protocol (`lease`, `exec`, `heartbeat`, `artifacts`, `kill`) with a
  **local Docker** backend that mounts a git worktree and starts the harness inside the container.
- Add `apps/api`: Bun + Hono HTTP API — sessions, runs, events (SSE with replay), health.
- Add Postgres read model migration `002_runs_events.sql` (runs, run_steps, events) — derived from Temporal,
  never authoritative.
- Add `compose.yaml` (postgres, temporal dev server, api, worker) and `scripts/smoke.sh`.
- Add a **fake harness adapter** so CI can exercise the full path without model credentials.

## Capabilities

### New Capabilities
- `run-lifecycle`: durable, resumable, cancellable agent runs with a pinned factory definition version.
- `harness-adapter`: a harness-agnostic contract producing a canonical event stream, with graceful
  degradation via capability flags.
- `runner-protocol`: sandbox leasing and tool execution isolated from the API process.
- `event-stream`: append-only event log with monotonic sequence numbers and SSE replay.

### Modified Capabilities
<!-- none: factory-definition is unchanged -->

## Impact

- New deps: `@temporalio/client|worker|workflow`, `hono`, `zod` (already), Postgres client (Bun SQL).
- New services in compose: postgres, temporal, api, worker. Runner containers are created per run.
- Phase 2b (Next.js UI + Playwright) consumes `apps/api` only; no direct harness or DB access.
- Security: inference credentials stay in the worker/api process, never inside the runner container.
