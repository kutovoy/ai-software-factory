# Design

## Topology

```
Web console ── API ── Postgres
                  └── Temporal (central, durable)
                          │
                          │  DB command queue + HTTP(S) polling
                          ▼
                   factory-runner-agent (remote host)
                          │
                          ├── Docker sandbox per run
                          └── harness adapter (opencode/fake) + event buffer
```

The central worker writes commands to `runner_commands` and waits for results. The agent
polls the API (`GET /api/v1/runner-agent/commands`) over outbound HTTP(S), executes locally
and posts the result. No inbound ports, no Temporal worker and no Postgres client on the
host.

## Agent execution

`lease` creates the sandbox through the existing `DockerRunnerBackend` (or
`LocalRunnerBackend` for a dev host). `start-session` creates the harness adapter on the
agent, starts the session, sends the prompt and keeps the event iterator in memory.
`pump` returns canonical events with `seq > fromSeq`, stopping at a permission request, a
terminal event, cancellation or an idle timeout. The central worker appends events to the
event log (single writer, idempotent by `(runId, seq)`) and records permissions.

This keeps the existing `RunWorkflow` unchanged: `leaseRunner` → `startHarness` →
`pumpEvents` → `collectArtifacts` → `killRunner`, with the harness activities branching to
remote commands when `input.runner === 'remote'`.

## Enrollment

1. Console creates an enrollment (`POST /api/v1/runners/enrollments`) with name, platform,
   arch, pool, labels, capacity. The API returns a one-time token, a preflight command and
   an install command.
2. The preflight script posts checks to `POST /api/v1/runner-enrollments/:token/preflight`.
3. The agent calls `POST /api/v1/runner-agent/enroll` with the token and host metadata.
   The API marks the enrollment used, creates a host row and returns a random agent token
   (only its SHA-256 hash is stored).
4. The agent heartbeats and polls commands with `Authorization: Bearer <agentToken>`.

## Scheduling

`selectRunnerHost` picks a `ready`, non-draining host matching platform/pool/labels with
free capacity (`max_concurrent` minus active leases). No match fails with
`no_matching_runner`. A lease row is reserved before the command is sent; the worker
releases it on kill/expiry.

## Metrics and alerts

The agent reports CPU, load, memory/swap, per-mount disk/inode usage, uptime, process count
and lease count every 15–30 s. The API stores a sample in `runner_metrics` and evaluates
enabled rules against the latest sample (duration rules check the window of samples). A
worker loop evaluates `heartbeat_age_seconds` for hosts whose last heartbeat is stale.

Alerts dedupe by `(host, rule)` and move `firing → acknowledged → resolved`, with a
silence window. The console shows firing/acknowledged/resolved alerts and exposes
acknowledge/silence actions. A webhook delivery is recorded in the existing outbound
webhook path when configured.

## Security

- Agent tokens are random, hashed at rest, revocable by deleting/rotating the host.
- The agent receives only the per-run proxy token; provider credentials never leave the
  API/worker.
- Execution secrets are referenced by name and resolved on the agent; the wire payload
  carries names, not values.
- TLS termination is expected at the central edge in the MVP; `cert_fingerprint` is reserved
  for mTLS follow-up.

## Failure and idempotency

- Commands are keyed by `runnerId`/`runId`; retries re-attach to the same sandbox.
- The agent reuses the existing Docker container name derivation, so a repeated lease
  inspects and re-attaches instead of creating a second container.
- A command that never completes is marked `expired`; the activity fails with
  `runner_unavailable` and the workflow records the error.
- `kill` is idempotent and always attempted in the workflow's non-cancellable cleanup.
