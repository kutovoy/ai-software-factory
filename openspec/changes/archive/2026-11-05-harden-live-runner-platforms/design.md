# Design

## Context

The remote-runner control plane, native backends and artifact store shipped with unit/API coverage,
but the first live macOS and Linux runs failed before reaching the harness. This change records the
runtime fixes and the invariants they enforce. See `proposal.md` for the failure list.

## Goals / Non-Goals

**Goals:**
- A remote run can lease, start an opencode session, stream events, collect/upload artifacts and
  download them on macOS native and Linux Docker.
- Native agents have the same harness provider configuration as the Docker image.
- A failed harness session cannot leave a run `running` forever.
- Agent shutdown leaves no harness child or sandbox container behind.

**Non-Goals:**
- A truly separate remote host, Windows live execution, Windows containers, macOS Tart, mTLS
  rotation and service wrappers.

## Decisions

- **Exclusive repo source.** `RepoSpec` already rejects `path` + `url`; `repoSpecForRun` now chooses
  one source and falls back to `RUNNER_REPO_URL` for work-item stage inputs that only carry a path.
- **Inline opencode config.** `OPENCODE_CONFIG_CONTENT` carries the same `packages/runners/docker/opencode.json`
  content in the harness command. Docker tolerates the duplicate source; native agents no longer need
  a pre-installed config.
- **Remote network allowed.** Remote harnesses must reach the per-run inference proxy and artifact
  store. The host's egress allowlist is the boundary; the sandbox still denies local writes outside
  the workspace/run dir/tmp.
- **Per-run native sandbox directories.** Remote leases no longer receive `/app/runs/...`. The local
  backend creates a temp run directory and a temp HOME/XDG tree for `sandbox-exec`, removing both on
  kill.
- **Terminal-status probe.** `PumpSource.status()` is called only after an idle window. The opencode
  adapter reads `session.outcome` and the assistant error message, so a pre-subscription failure ends
  the run as `error` instead of hanging.
- **Endpoint split.** `S3_ENDPOINT` is the agent upload URL; `S3_PUBLIC_ENDPOINT` is the browser
  download URL, defaulting to `S3_ENDPOINT`.

## Risks / Trade-offs

- [Risk] Native agents still have weaker isolation than Linux containers → Mitigation: document
  dedicated hosts/users; keep `sandbox-exec` and per-run HOME.
- [Risk] Remote network is allowed by default → Mitigation: host egress allowlist is the boundary;
  local sandboxes still default to denied.
- [Risk] Terminal-status polling adds one request per idle window → Mitigation: only on idle, with a
  short timeout and no false terminal on transport failure.
