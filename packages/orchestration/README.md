# `@factory/orchestration`

Temporal workflows, activities and the client for durable runs. One `RunWorkflow` per run
(ADR-001); Postgres is only a derived read model (ADR-010); the harness runs inside the
runner (ADR-009) and reaches models only through the API's inference proxy (ADR-011).

```
apps/api ──startRun──▶ Temporal ──▶ worker (this package) ──▶ @factory/runners lease
                                              │                └─ harness (opencode | fake)
                                              ├─ @factory/adapters stream ──▶ events.jsonl + events table
                                              └─ permissions ◀── Update/Signal ◀── POST /runs/:id/permissions/:id
```

## Workflow shape

`persistRun → issueProxyToken → leaseRunner → startHarness → pumpEvents (segments, one per
permission) → appendTerminalEvent → collectArtifacts → finishRun → revokeProxyToken → killRunner`

- **Human permissions (ADR-013)**: `pumpEvents` returns as soon as the harness emits
  `permission.requested` (the canonical event is persisted exactly once). The wait lives in
  workflow state: a Temporal **Update** `submitPermissionDecision` (preferred) or the **Signal**
  `permissionDecision` resolves `condition()`; the workflow then runs `respondPermission` and
  resumes the cached adapter stream from `lastSeq`. A blocked run holds **no activity slot**.
  `PERMISSION_TIMEOUT_MS` is the SLA that auto-denies and ends the run `error`.
- **Cancel**: `POST /runs/:id/cancel` sends the `cancel` signal; the workflow cancels the
  pump activity, the adapter aborts, a `run.completed(cancelled)` event is appended (unless
  the adapter already emitted one) and the sandbox is killed.
- **Worker restart**: Temporal re-delivers the in-flight activity. The adapter session is
  recreated (resume when supported), and event writes are deduplicated by `(runId, seq)`,
  so nothing is written twice. `run_steps` is keyed by `runId + stepId`.
- **Retries**: persistence 10×/2 min, runner 3×/15 min (60 s heartbeat), harness 5×/2 h
  (30 s heartbeat), proxy 5×/1 min — all exponential backoff. See `src/workflows/run.ts`.

## Run directory (task 5.3)

```
runs/<runId>/
  events.jsonl     append-only canonical FactoryEvent log (one JSON object per line)
  patch.diff       git diff of the sandbox workspace at run end
  artifacts/       collected artifacts (logs, screenshots, files, usage.json)
  workspace/       fake-harness only: empty workspace for the ephemeral lease
```

The directory is retained after the terminal state; only the sandbox is removed. Artifacts
are referenced by path + sha256 — blobs never go into Postgres.

## Commands

```bash
bun packages/orchestration/src/worker.ts      # worker (TEMPORAL_ADDRESS, DATABASE_URL)
bun scripts/migrate.ts                        # apply packages/core/migrations
docker compose up -d && bash scripts/smoke.sh # full stack smoke test
```

Env: `TEMPORAL_ADDRESS`, `TEMPORAL_NAMESPACE`, `TEMPORAL_TASK_QUEUE`, `DATABASE_URL`,
`FACTORY_ROOT`, `RUNS_DIR`, `PROXY_PUBLIC_URL`, `OPENAI_BASE_URL`, `OPENAI_API_KEY`,
`RUNNER_BACKEND` (`docker` | `local`), `PERMISSION_TIMEOUT_MS`,
`WORKER_MAX_CONCURRENT_ACTIVITY_TASKS` (default 100), `WORKER_MAX_CONCURRENT_WORKFLOW_TASKS`
(default 100). Only *streaming* runs consume activity slots; permission waits consume none.

## Setup commands

`runners/<name>.yaml` `setupCommands` are executed through the `runCommand` activity after the
lease (the harness is already listening), inside the sandbox, best-effort. Output is kept as
`runs/<runId>/artifacts/setup-N.log` and the exit code on `run_steps`; a failure never fails
the run.

## Fake harness

`harness: fake` leases an **ephemeral** runner: no container, no process, no network. The
`FakeAdapter` emits the scripted canonical sequence, so CI and `scripts/smoke.sh` exercise
the whole pipeline with zero credentials.

## Proxy env inside a real runner

`@factory/runners` rejects any `OPENAI_*` key in `spec.env` / `spec.harness.env` (provider
credentials must never enter a sandbox). The proxy therefore reaches the harness through the
harness **command**:

```
OPENAI_BASE_URL='<proxy>/v1' OPENAI_API_KEY='rsk_…' opencode serve --hostname 0.0.0.0 --port 4096
```

Only the per-run token (model allowlist, revoked at run end) is exposed — never the provider
key. The token also appears in the Temporal activity history, which is orchestrator-side; it
is revoked when the run reaches a terminal state.
