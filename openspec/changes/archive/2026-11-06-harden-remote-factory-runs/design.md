# Design

## Context

A factory work item can declare `runner: remote`, but stage dispatch resolved the runner as
`node.runner ?? input.defaultRunner`. The compiled stage node always has a runner because
`resolveStageConfigs` falls back to `agentDefaults.runner`; therefore the work-item body was
only a fallback that never applied. The first macOS remote cycle ran every stage on
`local-docker` despite the request.

The remote pump activity calls the agent's `pump` command, which long-polls for up to 20s.
The agent processes commands serially, so two concurrent review runs can queue behind each
other. The worker used a 60s command timeout and only heartbeated after each result, so a
healthy run could be killed with `activity Heartbeat timeout`.

A Linux agent container uses the host Docker socket to create sandboxes on
`RUNNER_DOCKER_NETWORK` (normally `factory-runners`). The agent probes the sandbox harness by
container IP. If the agent itself is only on the default bridge, the probe cannot reach
`172.x.x.x:4096`; the lease fails `harness ... was not ready`.

## Goals / Non-Goals

**Goals:**
- Work-item runner overrides are honored.
- Concurrent remote stage runs keep their pump activities alive while queued.
- The Linux agent setup is documented so a sandbox-network lease is reachable.

**Non-Goals:**
- Parallelizing the agent command loop (commands remain serial; the timeout is the guard).
- Changing the provider-key boundary or remote host trust model.
- Windows live verification or Tart.

## Decisions

- **Runner override precedence:** fake harness → explicit `runnerOverride` → stage node
  runner → default runner. Implemented as a pure `selectStageRunner` helper with unit tests.
- **Heartbeat pulse:** `heartbeatPulse` runs every 5s around the remote `pump` command; the
  command timeout is `max(120s, REMOTE_COMMAND_TIMEOUT_MS)`.
- **Network requirement:** the Linux agent container joins `factory-runners` in addition to
  the default bridge; the README documents `docker network connect factory-runners <agent>`.
- **No new database schema.**

## Risks / Trade-offs

- [Risk] A serialized agent queue still limits throughput → Mitigation: 120s timeout and a
  documented capacity requirement; parallel command execution is a follow-up.
- [Risk] `runnerOverride` applies to every stage, including verify → Mitigation: that is the
  requested work-item semantics; per-stage definitions can still be used when no override is
  set.
- [Risk] Agent on two networks adds a route → Mitigation: only the agent container joins;
  sandboxes stay on the isolated runner network.
