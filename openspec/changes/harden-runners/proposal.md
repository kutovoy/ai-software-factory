# Proposal

## Why

The local runner only has a macOS `sandbox-exec` profile; Linux workers fall back to no sandbox. Benchmarks are
hermetic but not replayable from recorded runs, and a React hydration warning makes the UI audit flaky.

## What Changes

- **Linux sandbox:** add a bubblewrap (`bwrap`) profile with read-only root, writable workspace and optional
  network isolation; auto-detect on Linux, explicit `RUNNER_SANDBOX=bwrap|exec|none`.
- **Recorded replay:** a replay adapter that emits a recorded canonical event stream and applies the recorded
  patch, usable by benchmark trials (`replay` mode) for deterministic regression runs.
- **Flake fix:** time formatting no longer causes server/client hydration mismatches; the UI audit asserts the
  warning is gone.

## Capabilities

### New Capabilities
- `runner-sandbox`: portable sandbox profiles.
- `benchmark-replay`: recorded-run replay for benchmarks.

## Impact

- `packages/runners`, `packages/adapters`, `packages/evals`, `packages/orchestration`; no schema break for
  existing factories.
