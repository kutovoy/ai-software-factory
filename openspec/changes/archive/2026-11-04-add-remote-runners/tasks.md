# Tasks

## 1. Foundation

- [x] 1.1 Add `remote` runner kind and the remote wire protocol types.
- [x] 1.2 Add migration `022_remote_runners.sql` (hosts, enrollments, leases, commands,
  metrics, alert rules, alerts).
- [x] 1.3 Add remote-runner config (enabled, platform, pool, repo URL, command timeout).

## 2. Agent

- [x] 2.1 Implement host metrics collection (CPU, RAM, disk/inodes, load, uptime).
- [x] 2.2 Implement the agent runtime: lease, exec, start-session, pump, permission,
  artifacts, cancel, kill, smoke test.
- [x] 2.3 Implement the agent daemon: enroll, state file, heartbeat loop, command poll,
  result posting, graceful shutdown.
- [x] 2.4 Unit tests for metrics and command routing.

## 3. Control plane

- [x] 3.1 Implement the runner host store: enrollment, token hashing, host registry,
  scheduling, leases, command queue, metrics, alerts.
- [x] 3.2 Implement alert evaluation (threshold, duration, heartbeat age) and lifecycle.
- [x] 3.3 Implement `RemoteRunnerBackend` and remote harness activities.
- [x] 3.4 Branch runner/harness activities on `input.runner === 'remote'`.
- [x] 3.5 Start the heartbeat-alert loop in the worker.

## 4. API

- [x] 4.1 Add global runner routes: list/detail, enrollment, drain/delete, metrics, alerts,
  alert rules.
- [x] 4.2 Add agent routes: enroll, heartbeat, claim command, post result; bearer auth.
- [x] 4.3 Update `apps/api/openapi.json` and the route-parity contract.
- [x] 4.4 Add API tests for rejection codes and validation.

## 5. Console

- [x] 5.1 Add Runners nav item, page, add-runner wizard (preflight + install command).
- [x] 5.2 Add host detail with CPU/RAM/disk sparklines, leases and alerts.
- [x] 5.3 Add alert list and acknowledge/silence actions.
- [x] 5.4 Add help entries and menu reference updates.

## 6. Operations and verification

- [x] 6.1 Add compose/example env for a Linux agent and document the install command.
- [x] 6.2 Update `packages/runners/README.md`, specs and docs.
- [x] 6.3 Run typecheck, unit tests, OpenSpec validation and the existing CI gate.
- [x] 6.4 Record the Linux MVP limitation (agent-side adapter, TLS-at-edge, no Windows/macOS
  yet) in STATUS/HANDOVER.
