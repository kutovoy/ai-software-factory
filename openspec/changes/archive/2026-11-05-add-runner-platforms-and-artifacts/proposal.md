# Proposal

## Why

The Linux remote-runner MVP proves the outbound control plane, but three production gaps remain:

1. Remote runs only return `patch.diff`. Other artifacts (logs, screenshots, test reports,
   traces, coverage) are collected into a temporary directory on the agent and then deleted,
   so the central run has metadata but no durable evidence. Review/verify gates, console
   inspection, benchmarks and audit need those bytes.
2. Runner hosts are Linux-only. Windows and macOS hosts cannot enroll or execute a run even
   though the protocol and database already carry a `platform` field.
3. The Runners console has no browser-level end-to-end coverage, so enrollment, host detail,
   metrics and alert actions are only covered by unit/API tests.

MinIO is the accepted S3-compatible artifact store (ADR-047). This change wires it into the
remote-runner path and adds native Windows/macOS agent support.

## What Changes

- Add an **artifact store** abstraction with MinIO as the default S3-compatible backend:
  short-lived presigned upload grants for agents, per-run/tenant object prefixes, checksum
  and size verification, and presigned download links for the console/API.
- Add **agent artifact upload**: after collecting artifacts, the agent requests presigned PUT
  URLs from the control plane, uploads each blob over outbound HTTPS, and returns object keys
  with the artifact metadata. `patch.diff` remains in the command result for downstream stages.
- Add **Windows native agent support**: PowerShell preflight/install generation, a native
  process backend using PowerShell, Windows CPU/RAM/disk/process metrics, and platform-aware
  agent defaults.
- Add **macOS native agent support**: macOS preflight/install generation, the existing
  `sandbox-exec` local backend, macOS swap/process metrics, and platform-aware defaults.
- Enable Windows/macOS in the Runners add-runner wizard and update the console copy.
- Add a **Runners Playwright E2E** flow: enrollment, generated commands, simulated heartbeat,
  host detail metrics, alert firing and host deletion.
- Update OpenAPI, help entries, runner README, compose/MinIO, `.env.example` and docs.

## Capabilities

### New Capabilities

- `artifact-store`: S3-compatible object storage for run artifacts, presigned upload/download,
  checksum/size verification and retention metadata.

### Modified Capabilities

- `remote-runners`: Windows and macOS hosts enroll and execute native runs; the agent uploads
  artifacts to object storage.
- `runner-observability`: Windows/macOS metric collection and platform-aware preflight checks.
- `runner-protocol`: artifact metadata can carry an object-store key; native process backends
  implement the same lease/exec/heartbeat/artifacts/kill contract.
- `http-api`: presign, artifact-download and platform-aware enrollment routes.
- `web-console`: Windows/macOS enrollment, artifact download links and Runners E2E coverage.

## Impact

- `packages/runners/src/agent.ts`, `agent-runtime.ts`, `agent-metrics.ts`, `local.ts`,
  `remote-protocol.ts`, `protocol.ts`, `util.ts`.
- `packages/orchestration/src/artifact-store.ts` (new), `remote-runner.ts`, activities and
  config.
- `apps/api/src/runner-agent.ts`, `runners.ts`, `app.ts`, `openapi.json`.
- `apps/web` Runners page/components, run artifact links, help and wire types.
- `packages/core/migrations` (artifact object metadata if a table is needed).
- `compose.yaml`, `.env.example`, `packages/runners/README.md`, docs and OpenSpec specs.
- `apps/web/e2e/runners.spec.ts` (new).

## Non-goals

- Windows containers and macOS Tart VMs are not part of this slice; native process backends
  ship first. Windows/macOS native isolation is weaker than Linux containers and needs
  dedicated hosts for untrusted code.
- mTLS certificate issuance/rotation remains a follow-up; the agent token stays
  bearer-authenticated behind TLS.
- Full retention/GC automation is limited to configuration + a documented operator path in
  this slice.
- MinIO is AGPLv3; redistribution needs a licence review.
