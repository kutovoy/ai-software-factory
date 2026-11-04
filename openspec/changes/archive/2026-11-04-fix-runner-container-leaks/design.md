# Design

## Context

The Docker backend creates one detached container per run, labelled `factory.runner`,
`factory.run` and `factory.workspace`. Normal cleanup is `RunWorkflow` → `killRunner`.
Cancellation is cooperative, but Temporal cancellation can arrive between any two awaits.

## Decisions

### 1. One non-cancellable cleanup scope

`RunWorkflow` now performs terminal event append, artifact collection, terminal-state read,
`finishRunActivity`, proxy revocation and `killRunner` inside a single
`CancellationScope.nonCancellable`. Each step is best-effort except the terminal event;
`killRunner` is always attempted last. This removes the cancellation window between
artifact collection and the final writes.

### 2. Lease-time cancellation cleans up deterministically

`leaseRunner` heartbeats every 5s while Docker builds/starts/waits for readiness. If a
heartbeat observes cancellation, or the lease throws, the backend kills the deterministic
container name before rethrowing. This covers a container created before a lease handle was
returned.

### 3. `killRunner` can clean up without a lease

When cancellation lands before `leaseRunner` returns, the workflow has no lease object.
`killRunner` derives `factory-<runId>`, calls `backend.kill`, records an orphan-cleanup step
and continues. Ephemeral (fake/replay) runs skip the sandbox path.

### 4. Label-based reaper is the safety net

The worker periodically lists containers with `label=factory.runner`, joins `factory.run`
to `runs.status`, and checks Temporal for `running` rows. It removes a container when:

- the run row is missing,
- the run is terminal (`ok`, `error`, `cancelled`),
- the workflow is closed,
- the workflow is missing and the container is older than the grace period,
- the container exceeds the max age with no live workflow.

If Temporal is unavailable, `running` containers are skipped so an outage cannot kill live
work. Removed `running` runs are marked `error` with `runner_orphaned: <reason>` and a
`runner-reaper` step.

### 5. Reaper lives in the worker

The worker already has the Docker socket and Postgres. It starts the reaper on boot and then
every `RUNNER_REAPER_INTERVAL_MS` (default 5 minutes). `RUNNER_REAPER_DRY_RUN=1` logs only.
`scripts/reap-runners.ts` uses the same code path for local cleanup.

### 6. Worker shutdown gets a grace window

`Worker.create` sets `shutdownGraceTime: 90s` and `shutdownForceTime: 120s`; compose gives
the worker `stop_grace_period: 150s`. This lets in-flight cleanup finish before SIGKILL.

## Risks / Trade-offs

- A very long live run could exceed `RUNNER_REAPER_MAX_AGE_MS` (default 6h); the harness
  activity timeout is 2h, so this is intentionally generous.
- The reaper is conservative when Temporal is unreachable.
- The one-time cleanup marks 29 stale `running` rows `error`; this is accurate: their
  workflows are canceled or gone.

## Migration

No schema migration. Apply the code, rebuild the worker, then run
`bun run reap:runners -- --apply` (or let the worker reaper do it) once.
