# Proposal

## Why

The first full remote-runner factory cycles exposed three issues that unit tests did not catch:

1. A work-item `runner: remote` request was ignored for factory stages. The compiled stage
   node always carries a runner (from `agentDefaults.runner`), and the workflow used
   `node.runner ?? defaultRunner`, so the work-item override never won. The first macOS run
   silently executed on `local-docker`.
2. Concurrent review runs on one remote host caused `activity Heartbeat timeout`. The remote
   pump activity waited on a serialized agent command queue without heartbeating, and its
   command timeout was shorter than the queue delay.
3. A Linux agent container that creates sandboxes on `factory-runners` could not reach the
   sandbox IP unless the agent itself joined that network; the first Linux lease failed
   `harness ... was not ready`.

## What Changes

- Add an explicit `runnerOverride` to `FactoryWorkflowInput`; a work-item `runner` body value
  wins over the compiled stage node for every stage (the fake harness still uses `fake`).
- Keep the remote pump activity alive with a heartbeat pulse while it waits for an agent
  command, and allow up to 120s for a queued remote pump command.
- Document that a Linux remote agent which uses `RUNNER_DOCKER_NETWORK=factory-runners` must
  also join that network so it can probe the sandbox harness.
- Record the two successful live factory cycles (macOS native and Linux Docker) with PRs #13
  and #14.

## Capabilities

### Modified Capabilities

- `factory-loop`: work-item runner override.
- `remote-runners`: remote pump liveness under concurrent stage runs.

## Impact

- `packages/orchestration/src/stage-runner.ts`, `types.ts`, `workflows/factory.ts`,
  `activities/harness.ts`, `heartbeat.ts`, `index.ts`.
- `apps/api/src/work-items.ts`.
- `packages/runners/README.md`, `docs/STATUS.md`, `docs/ROADMAP.md`, `docs/HANDOVER.md`.
- Tests: `packages/orchestration/test/stage-runner.test.ts`.
