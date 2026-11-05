# Remote runners and worker observability — plan

**Status:** Linux, Windows and macOS native agents + observability + MinIO artifacts implemented on
`main`; OpenSpec changes archived.
**Last updated:** 2026-11-05.
**Merged to:** `main`.
**OpenSpec changes:** `2026-11-04-add-remote-runners` (control plane, observability) and
`2026-11-05-add-runner-platforms-and-artifacts` (Windows/macOS native agents, MinIO artifacts, Runners E2E).

This document is the handoff/compaction anchor for the next workstream. It records the
GPUSTACK review, the chosen direction, the metrics/alerts scope, and the phase boundaries.

---

## 1. Why this shape

GPUSTACK’s worker model is a useful reference:

- UI: **Clusters → Add Worker** → select vendor → **Check Environment** → specify
  IP/volumes → **Run command**.
- The backend exposes `GET /clusters/{id}/registration-token` with `token`, `server_url`,
  `image`, `env`, `args`; the UI renders the install command
  ([`gpustack/routes/clusters.py`](https://github.com/gpustack/gpustack/blob/main/gpustack/routes/clusters.py)).
- The generated command is a `docker run` worker container with the Docker socket, a data
  volume and the registration token
  ([`gpustack-ui` `gpu-driver.ts`](https://github.com/gpustack/gpustack-ui/blob/main/src/pages/resources/config/gpu-driver.ts)).
- The worker registers, receives a worker token, posts status/heartbeats, and spawns
  per-model workloads locally
  ([`worker_manager.py`](https://github.com/gpustack/gpustack/blob/main/gpustack/worker/worker_manager.py),
  [`serve_manager.py`](https://github.com/gpustack/gpustack/blob/main/gpustack/worker/serve_manager.py)).
- The server has a worker state machine (`pending → provisioning → initializing → ready →
  not_ready/unreachable → maintenance → deleting/error`)
  ([`schemas/workers.py`](https://github.com/gpustack/gpustack/blob/main/gpustack/schemas/workers.py)).
- GPUSTACK only supports **Linux workers**; Windows workers are via WSL2 and macOS workers
  are not supported
  ([installation docs](https://docs.gpustack.ai/2.1/installation/installation/)).

We will copy the shape — UI-driven host onboarding, preflight, generated install command,
agent registration, heartbeats, local sandbox spawning — and improve the weak parts:
one-time enrollment tokens, outbound-only mTLS, no provider keys on the host, real
preflight checks, platform-specific backends, event/artifact streaming, and host
metrics/alerts.

---

## 2. Current state in this repo

The runner layer is local and in-process:

- `packages/runners/src/protocol.ts` defines `RunnerBackend` (`lease`, `exec`,
  `heartbeat`, `artifacts`, `kill`).
- Only `DockerRunnerBackend` and `LocalRunnerBackend` exist.
- `packages/orchestration/src/activities/runner.ts` chooses them in `backendFor()`; there is
  no `remote` branch.
- The Docker backend shells out to the local Docker CLI; `compose.yaml` mounts
  `/var/run/docker.sock` into the worker.
- `leaseRunner` returns a `harnessUrl`; `pumpEvents` connects to it from the worker.
- Artifacts are collected with `docker cp` / local filesystem copy.
- The reaper scans local Docker labels.
- Secrets are resolved in the worker and injected into the sandbox; inference/provider keys
  are banned from runners.

So “remote runner” is not just moving the worker. The worker can already run elsewhere only
if it can reach Postgres/Temporal and has a Docker socket; that is a distributed worker,
not the remote-runner protocol we want.

---

## 3. Target architecture

```
Web console ── API ── Postgres
                  └── Temporal (durable workflows, gates, timers, retries)
                          │
                          │  outbound mTLS control stream (agent-initiated)
                          ▼
                   factory-runner-agent  (one per host)
                          │
             ┌────────────┼────────────┐
             ▼            ▼            ▼
        Linux Docker   Windows      macOS
        per-run        native or    native or
        container      Windows      Tart VM
                       container
```

### Core decisions

1. **No Temporal or Postgres on remote hosts.** The central Temporal worker remains the
   scheduler and owner of workflow state. The remote agent is an executor, not a Temporal
   worker.
2. **Agent-initiated, outbound-only mTLS.** No inbound ports on runner hosts. The agent
   opens a persistent control stream (or long-poll) to central and receives lease/exec/
   stream/artifact/kill commands.
3. **One-time enrollment.** The UI generates a one-time enrollment token; the agent
   exchanges it for an mTLS certificate/worker token. The long-lived credential never sits
   in the `docker run` command line.
4. **Central scheduling.** A deterministic scheduler picks a host by platform, pool,
   labels, tenant and free capacity, reserves a lease in Postgres, and returns it to the
   workflow. If no host matches, the run fails with `no_matching_runner`.
5. **Temporal stays durable.** `RunWorkflow` → `leaseRunner` → `pumpEvents` →
   `collectArtifacts` → `killRunner`; activity heartbeats, idempotent `(runId, seq)` event
   writes, lease TTLs and resumable streams preserve current durability.
6. **Platform backends.** Linux Docker first; Windows native process (MSBuild/dotnet) and
   optional Windows containers; macOS native Xcode process and optional Tart VM.

### Rejected for v1

Making every remote host a Temporal worker. It puts Temporal connectivity and activity code
on the host, and current runner activities write to Postgres. It also splits the activity
model. Temporal’s worker-specific task queue pattern is a later option for trusted pools,
not the first remote-runner implementation.

---

## 4. Runner host model

### Tables (planned)

- `runner_hosts`: id, tenant/owner, name, platform (`linux|windows|macos`), arch, labels,
  pool, capacity, agent version, status, last heartbeat, drain mode, cert fingerprint.
- `runner_enrollments`: one-time token hash, expiry, used-at, requested host metadata.
- `runner_leases`: lease id, run id, host id, sandbox id, state, expires-at, heartbeat,
  workspace/artifact refs.
- `runner_metrics`: host id, captured-at, CPU, memory, disk, load, process/lease counts,
  agent version; JSONB payload + indexed timestamp.
- `runner_alert_rules`: scope (global/pool/host), metric, threshold, duration, severity,
  channel.
- `runner_alerts`: host id, rule id, state (`firing|acknowledged|resolved|silenced`),
  first/last seen, value, dedupe key, resolution.

### Labels/capabilities

- `os=linux|windows|macos`
- `arch=x86_64|arm64`
- `pool=default|windows-build|macos-xcode|...`
- `docker=linux|windows|none`
- `toolchains=node,bun,git,dotnet,msbuild,xcode,swift,...`
- `tenant=<id>`, `region=<id>`, `gpu=<vendor>`, `maxConcurrent=<n>`

Factory definitions can request a runner pool/platform (`runner: remote`,
`runnerPool: windows-build`, `platform: windows`). No match → `no_matching_runner`.

### State machine

`pending → provisioning → initializing → ready → not_ready/unreachable → maintenance →
deleting/error`, mirroring GPUSTACK’s worker states. Heartbeat gaps move a host to
`unreachable`; maintenance/drain stops new leases but lets running leases finish or be
killed explicitly.

---

## 5. UI flow

### Runners page

- List hosts: name, platform, arch, pool, labels, status, agent version, last heartbeat,
  CPU/RAM/disk gauges, running leases, max concurrency.
- Actions: drain, remove, rotate enrollment, view logs, run smoke test, edit labels/pool.

### Add Runner wizard

1. Name, platform/arch, pool, labels, max concurrency.
2. **Preflight** — generated platform-specific test command. The script checks the host and
   POSTs a signed JSON result using the enrollment token; the UI advances automatically on
   pass. This is stricter than GPUSTACK’s single driver/runtime check.
3. **Install command** — generated for the platform:
   - Linux: `docker run` agent container with Docker socket, workspace volume, enrollment
     token, CA fingerprint, labels. Avoid `--privileged` by default.
   - Windows: PowerShell installer that registers the agent as a Windows service; optional
     Windows-container mode.
   - macOS: `curl | bash` or launchd plist installer.
4. Host appears `pending → initializing → ready`; run a smoke test before accepting work.

### Alerts UI

- Runner detail: CPU/RAM/disk sparklines, lease history, agent logs.
- Alerts list: firing/acknowledged/resolved, host, rule, value, duration.
- Inbox integration for admins/owners; optional webhook/Slack notification.
- Alert rule editor per global/pool/host.

---

## 6. Host metrics and alerts

### Metrics

Agent reports every 15–30 s (configurable). Central stores 1-minute aggregates; raw samples
short-retention, rollups longer.

| Metric | Details |
|---|---|
| CPU | total percent, per-core optional, load1/5/15 |
| RAM | total, used, available, cached, swap used/total |
| Disk | per mount: total, used, free, percent, inodes; root, workspace, Docker data |
| Host | uptime, process count, agent version, Docker/containerd version |
| Runner | running leases, max concurrency, queue wait, last lease duration |
| Platform | Windows: CIM/performance counters; macOS: `host_statistics64`/`sysctl`/`statfs`; Linux: `/proc`/`statvfs` |

Metrics contain no secrets. Tenant/host scoping applies to reads.

### Default alert rules (configurable)

- CPU > 85% for 5 min → warning; > 95% for 2 min → critical.
- RAM > 85% for 5 min → warning; > 95% for 2 min → critical.
- Disk > 80% → warning; > 90% → critical; free < 10 GB warning, < 2 GB critical.
- Inodes > 90% → warning.
- Heartbeat missing > 2 intervals → warning; > 5 intervals → offline/critical.
- Lease queue wait > 10 min → warning.
- Agent version drift / failed smoke test → warning.
- Repeated run failures or OOM kills on a host → warning.

### Alert lifecycle

- Dedupe by `(host, rule)`; one firing alert per rule while active.
- States: `firing → acknowledged → resolved`, plus `silenced` for maintenance.
- Evaluate on heartbeat ingest for thresholds, and in a periodic worker loop for
  heartbeat-missing/offline.
- Channels: console inbox + webhook first; email/Slack later.
- Audit actor/reason for acknowledge/silence.

### API surface (planned, global not factory-scoped)

- `GET /api/v1/runners`
- `POST /api/v1/runners/enrollments`
- `POST /api/v1/runner-enrollments/:token/preflight`
- `GET /api/v1/runners/:id`
- `GET /api/v1/runners/:id/metrics?window=1h`
- `POST /api/v1/runners/:id/drain`
- `POST /api/v1/runners/:id/rotate`
- `DELETE /api/v1/runners/:id`
- `GET /api/v1/runner-alerts`
- `POST /api/v1/runner-alerts/:id/ack`
- `POST /api/v1/runner-alerts/:id/silence`
- `GET/PUT /api/v1/runner-alert-rules`

These are global resources, not nested under a factory. Factory-scoped resources keep the
existing `/api/v1/factories/:factoryId/...` convention.

---

## 7. Temporal scheduling details

- `RunWorkflow` stays central. The runner activities become remote-aware:
  - `leaseRunner`: scheduler picks host, reserves lease, calls agent `lease`.
  - `pumpEvents`: opens the agent event stream, persists canonical events, heartbeats,
    reconnects with `fromSeq` after a worker/agent restart.
  - `collectArtifacts`: agent uploads to object store or streams; central records metadata.
  - `killRunner`: agent kills sandbox; idempotent; deterministic fallback.
- Lease TTL and agent heartbeat; central reaper reconciles orphan leases and runs.
- No Temporal or Postgres credentials on the remote host.
- Later option: Temporal task queue per trusted pool, with runner-only activities and
  central persistence split. Not v1.

---

## 8. Platform notes

### Linux

- Agent container or systemd service.
- One Docker container per run; workspace bind/copy; per-run network policy; artifact
  upload. Closest to the current `DockerRunnerBackend`.

### Windows

- Agent runs as a Windows service, not Docker Desktop.
- `windows-process` backend first: native PowerShell/cmd, MSBuild/dotnet, job objects for
  process-tree kill, per-run temp dirs, restricted user/ACL.
- `windows-container` backend later: Windows containers with process or Hyper-V isolation
  when supported
  ([Microsoft isolation modes](https://learn.microsoft.com/en-us/virtualization/windowscontainers/manage-containers/hyperv-container)).
- Preflight checks Windows containers mode, `dotnet --info`, MSBuild, git, long paths,
  disk, network.

### macOS

- Agent runs as a launchd service.
- `macos-process` backend: `xcodebuild`, `swift`, `codesign`, `notarytool`; per-run temp
  dir; process-group kill; `sandbox-exec` as a weak guardrail.
- For untrusted code, use a disposable macOS VM per run (Tart/Anka) rather than relying on
  `sandbox-exec` ([Tart](https://tart.run/)).
- Code-signing credentials: dedicated keychain unlocked per run or short-lived signing
  identity; never in the agent image.
- Preflight checks `xcode-select`, `xcodebuild -version`, `codesign`, keychain identities,
  git/node/bun, disk, network.

---

## 9. Security and tenancy

- mTLS agent identity; one-time enrollment; short-lived certs; rotate/revoke in UI.
- No Postgres/Temporal/provider credentials on remote hosts.
- Egress allowlist: central, git forge, package registries, model proxy.
- Docker socket is root-equivalent: dedicated hosts, no `--privileged` by default,
  per-tenant pools, microVM/K8s later for untrusted tenants.
- Windows/macOS native runners are weaker isolation; use dedicated VMs/users for untrusted
  code.
- Artifacts in MinIO (S3-compatible); DB stores object key/hash/size only; logs scrubbed before upload.
- Metrics contain no secrets; alert reads are tenant-scoped.

---

## 10. Phases and exit criteria

### R0 — planning and ADR (current)

- This document + ADR-046.
- No branch, no code.

### R1a — Linux remote runner control plane

- Runners page + Add Runner wizard + preflight + generated `docker run`.
- Agent enrollment, mTLS, heartbeat, labels, capacity.
- Central scheduler, lease table, remote `lease/exec/events/artifacts/kill`.
- Temporal remote activities; lease TTL + reaper.
- **Exit:** one remote Linux host runs `hello-nextjs` lights-off end-to-end; kill the
  central worker mid-run; resume; no leaked container; PR merged; no provider key on host.

### R1b — runner observability

- Agent CPU/RAM/disk/host metrics; central storage/rollups.
- Runners page gauges/sparklines; host detail; alert list; alert rules.
- Inbox + webhook alerts; acknowledge/silence.
- **Exit:** a synthetic CPU/RAM/disk threshold triggers an alert, resolves when the value
  recovers, and is visible in the console; heartbeat-missing alert fires for an offline
  host.

### R2 — Windows runner

- Windows service agent + PowerShell preflight/install.
- Native MSBuild/dotnet backend; optional Windows containers.
- **Exit:** a Windows sample builds/tests on `os=windows`; no Linux host selected.

### R3 — macOS runner

- launchd agent + preflight/install.
- Native Xcode backend; optional Tart VM backend.
- **Exit:** a macOS sample builds/tests on `os=macos`; signing/keychain path works.

### R4 — hardening and multi-tenant

- mTLS rotation/revocation, per-tenant pools/quotas, drain/upgrade, object store, audit,
  cost attribution.
- Optional Kubernetes/cloud autoscaling; optional Temporal task queue per trusted pool.

---

## 11. Open questions

- Windows first backend: **decided** — native process first; Windows containers are a follow-up.
- macOS isolation: **decided** — native `sandbox-exec` first; Tart VM for untrusted code is a follow-up.
- Are runner hosts trusted single-tenant or untrusted multi-tenant? Drives isolation and
  network model.
- Artifact store: **decided** — MinIO as the default S3-compatible store (ADR-047); local disk
  only as a development fallback.
- Alert channel: console inbox + webhook first; email/Slack later.
- Network: public mTLS vs VPN/Tailscale. Recommendation: outbound-only mTLS; VPN optional.
- OS order: **implemented** — Linux Docker, Windows native, macOS native; Windows containers and macOS Tart remain.
- Retention: raw 1-minute samples 7 days, 5-minute rollups 30 days (proposal).

---

## 12. Compaction summary

- Remote runners will use a GPUSTACK-style host agent, but **no Temporal or Postgres on the
  remote host**.
- Central Temporal remains the durable scheduler; the agent is an executor over outbound
  mTLS.
- Linux first, then Windows native/Windows containers, then macOS native/Tart.
- Host metrics: CPU, RAM, disk/inodes, load, leases, heartbeat; alerts with configurable
  thresholds, dedupe, acknowledge/silence, console inbox + webhook.
- Implementation branches: `feat/remote-runners` and `feat/runner-platforms-artifacts` (merged to `main`).
- OpenSpec changes: `add-remote-runners` (archived as `2026-11-04-add-remote-runners`) and
  `2026-11-05-add-runner-platforms-and-artifacts`; `add-runner-observability` was folded into the first.
- **Implementation note (MVP):** the first slice runs the harness adapter *on the agent*
  and streams canonical events back to the central worker, which stays the single event
  writer. This avoids a reverse harness tunnel while keeping Temporal/Postgres off the
  host. The agent token is bearer-authenticated; deploy behind TLS, with mTLS certificate
  fingerprinting reserved for the hardening phase. Artifacts upload directly to MinIO through
  short-lived presigned PUT grants; `patch.diff` stays inline for downstream stages and is also stored
  as an object (ADR-047).
