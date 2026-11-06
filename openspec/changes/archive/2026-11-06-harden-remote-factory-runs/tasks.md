# Tasks

## 1. Work-item runner override

- [x] 1.1 Add `runnerOverride` to `FactoryWorkflowInput` and a pure `selectStageRunner`
  helper with fake → override → node → default precedence.
- [x] 1.2 Set `runnerOverride` from the work-item `runner` body and from the retry snapshot.
- [x] 1.3 Unit tests for override, node, default and fake precedence.

## 2. Remote pump liveness

- [x] 2.1 Add `heartbeatPulse` and pulse the remote pump while waiting for an agent command.
- [x] 2.2 Raise the remote pump command timeout to at least 120s.
- [x] 2.3 Verify with two concurrent review runs on one macOS host (PR #13).

## 3. Linux agent network

- [x] 3.1 Join the Linux agent container to `factory-runners` and document the requirement.
- [x] 3.2 Verify with a full Linux Docker factory cycle (PR #14).

## 4. Verification and docs

- [x] 4.1 `bun run ci` (831 pass, 172 skip, 0 fail).
- [x] 4.2 `openspec validate` and archive.
- [x] 4.3 Update STATUS, ROADMAP, HANDOVER and the runner README.
