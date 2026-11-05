# Proposal

## Why

Runner execution is local-only today: the worker leases Docker/process sandboxes on the same
host that runs Temporal and Postgres. Remote hosts cannot participate without exposing
Temporal/Postgres credentials or inbound ports, and the console cannot see host health.

The plan (`docs/REMOTE_RUNNERS_PLAN.md`) adopts GPUSTACK's onboarding shape — preflight,
generated install command, agent registration, heartbeats — but keeps the central Temporal
worker as the durable scheduler and the remote agent as an executor.

## What Changes

- Add a **runner agent** that enrolls once with a one-time token, exchanges it for an agent
  token, then polls an outbound command queue. No Temporal or Postgres access on the host.
- Add central **runner host registry**, **enrollment**, **leases**, **command queue**,
  **metrics** and **alert** tables.
- Add a **remote runner backend** in orchestration: `lease`, `exec`, `start-session`,
  `pump`, `respond-permission`, `artifacts`, `cancel`, `kill` travel as commands; the agent
  runs the harness adapter locally and streams canonical events back to the central worker.
- Add **Runners** and **Alerts** console surfaces: host list, add-runner wizard with
  preflight/install commands, CPU/RAM/disk gauges, lease counts, alert list and
  acknowledge/silence actions.
- Add **runner observability**: agent CPU/RAM/disk/inode/load/heartbeat metrics stored
  centrally; configurable alert rules evaluated on ingest and by a worker loop for missing
  heartbeats.
- Keep the provider-key boundary: the agent receives only the per-run proxy token, never
  `OPENAI_*` provider credentials. Execution secrets are referenced by name and resolved on
  the agent.

## Capabilities

### New Capabilities

- `remote-runners`: enrollment, host registry, scheduling, command protocol and remote
  run lifecycle.
- `runner-observability`: host metrics, alert rules, alert lifecycle and console surfaces.

### Modified Capabilities

- `runner-protocol`: a third backend (`remote`) implements the same lease/exec/artifact/kill
  contract; the agent is an executor, not a Temporal worker.
- `run-lifecycle`: remote runs use the same workflow and terminal semantics; the agent
  streams canonical events and artifacts back to the central writer.
- `http-api`: new global `/api/v1/runners*`, `/api/v1/runner-agent/*`,
  `/api/v1/runner-enrollments/*` and `/api/v1/runner-alerts*` routes.
- `web-console`: a Runners page, add-runner flow, host detail/metrics and alert actions.

## Impact

- `packages/runners/src/remote-protocol.ts`, `agent.ts`, `agent-runtime.ts`,
  `agent-metrics.ts`.
- `packages/orchestration/src/runner-hosts.ts`, `runner-alerts.ts`, `remote-runner.ts`,
  activities and worker loop.
- `packages/core/migrations/022_remote_runners.sql`.
- `apps/api/src/runners.ts`, `runner-agent.ts`, `app.ts`, `openapi.json`.
- `apps/web` Runners page/components, nav, help and wire types.
- `compose.yaml`, `.env.example`, runner package README, OpenSpec specs and docs.

## Non-goals

- Windows and macOS agent backends are follow-up changes (`add-windows-runner`,
  `add-macos-runner`). The Linux MVP ships first.
- Full mTLS certificate issuance is out of scope for the first slice; the agent token is
  bearer-authenticated and deployments are expected to terminate TLS at the central edge.
  The wire protocol reserves a certificate fingerprint field for the follow-up.
- Kubernetes/cloud autoscaling and per-tenant isolation are R4.
