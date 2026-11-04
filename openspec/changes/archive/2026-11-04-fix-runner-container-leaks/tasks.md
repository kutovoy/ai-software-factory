# Tasks

## 1. Cancellation cleanup

- [x] 1.1 Wrap all post-run cleanup in one `CancellationScope.nonCancellable` in `RunWorkflow`.
- [x] 1.2 Make `killRunner` clean up by deterministic name when no lease handle exists.
- [x] 1.3 Heartbeat `leaseRunner` and kill the sandbox when cancellation arrives while leasing.

## 2. Orphan reaper

- [x] 2.1 Add label-based `reapRunnerContainers` with DB + Temporal reconciliation and dry-run.
- [x] 2.2 Start the reaper periodically in the worker.
- [x] 2.3 Add `scripts/reap-runners.ts` and `bun run reap:runners`.
- [x] 2.4 Add unit tests for terminal/missing/closed/missing-workflow/live/unavailable/dry-run cases.

## 3. Shutdown and config

- [x] 3.1 Add `shutdownGraceTime`/`shutdownForceTime` to the Temporal worker.
- [x] 3.2 Add compose `stop_grace_period` and reaper env defaults.
- [x] 3.3 Document the reaper in `.env.example`.

## 4. Cleanup and verification

- [x] 4.1 Dry-run the reaper against the current stack (29 would-remove, 0 errors).
- [x] 4.2 Apply cleanup: remove 29 orphan containers, mark their runs `error`.
- [x] 4.3 Rebuild worker/API and confirm the reaper runs inside the worker.
- [x] 4.4 Run typecheck and the full test suite.
