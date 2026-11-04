# Proposal

## Why

Docker Desktop accumulated 29 `factory-runner-factory-run_*` sandbox containers. All 29
corresponded to runs still marked `running` in Postgres; 5 workflows were `CANCELED` and 24
were no longer visible to Temporal. None had a `kill-runner` or finish-run step.

The root cause is in `RunWorkflow`: cleanup was only partially inside a
`CancellationScope.nonCancellable`. After `collectArtifacts`, the workflow awaited
`readTerminalState` outside the non-cancellable scope. A cancellation delivered there
skipped `finishRunActivity` and `killRunner`, leaving both the container and a stale
`running` row. Lease-time cancellation and worker kills could also leak containers, and
there was no periodic reconciliation.

## What Changes

- Wrap the entire post-run cleanup in one non-cancellable scope, including terminal-state
  read, finish, proxy revocation and runner kill; `killRunner` runs last and best-effort.
- Make `killRunner` attempt deterministic-name cleanup even when the lease activity never
  returned a handle.
- Heartbeat `leaseRunner` and kill the sandbox when cancellation arrives while leasing.
- Add a label-based orphan reaper that compares `factory.run` containers with the run read
  model and Temporal, removes terminal/missing/closed-run containers, and marks orphaned
  `running` runs `error`.
- Run the reaper periodically in the worker (it already has Docker socket + Postgres), and
  expose `bun run reap:runners` with a dry-run default and `--apply`.
- Harden worker shutdown (`shutdownGraceTime`, `shutdownForceTime`, compose
  `stop_grace_period`).

## Capabilities

### New Capabilities
- None.

### Modified Capabilities
- `runner-protocol`: sandbox cleanup is guaranteed on cancellation, lease failure and
  orphan reconciliation.
- `run-lifecycle`: a canceled run always reaches a terminal row and releases its sandbox.

## Impact

- `packages/orchestration/src/workflows/run.ts`, `activities/runner.ts`, `worker.ts`,
  `config.ts`, new `runner-reaper.ts`.
- `packages/orchestration/test/runner-reaper.test.ts`.
- `scripts/reap-runners.ts`, `package.json`, `compose.yaml`, `.env.example`.
- One-time cleanup of the 29 existing containers; their run rows become `error` with
  `runner_orphaned`.

## Non-goals

- No change to the runner protocol shape or sandbox isolation model.
- No change to normal terminal-run semantics.
- No blanket `docker system prune`.
