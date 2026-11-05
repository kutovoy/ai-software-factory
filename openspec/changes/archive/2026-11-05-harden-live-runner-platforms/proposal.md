# Proposal

## Why

The remote-runner platform code had unit and simulated coverage but no live host execution. Running
real macOS M5 and Linux Docker agents exposed lease, native-config, sandbox, run-directory, terminal
state and artifact-download defects that would have blocked every real remote run.

## What Changes

- Send remote leases only the clone URL; never the central checkout path. Work-item stages fall back
  to `RUNNER_REPO_URL`.
- Pass the runner `opencode.json` inline through `OPENCODE_CONFIG_CONTENT` so native macOS/Windows
  agents resolve `factory/best_llm` without the Docker image.
- Rewrite the default harness port/hostname even when the command carries an env prefix.
- Give remote sandboxes their own per-run directory instead of the central `/app/runs/...` path.
- Give macOS `sandbox-exec` leases a writable per-run HOME/XDG tree.
- Allow network for remote runs (the remote host's egress allowlist remains the boundary).
- Close a run when a quiet pump finds the harness session terminal, instead of idling forever.
- Reap live harness/sandbox children on agent shutdown.
- Split `S3_ENDPOINT` (agent upload) from `S3_PUBLIC_ENDPOINT` (browser download).

## Capabilities

### Modified Capabilities

- `remote-runners`: remote checkout source, native harness provisioning, remote network policy,
  terminal-status fallback and shutdown cleanup.
- `runner-sandbox`: per-run remote sandbox directory and writable macOS HOME/XDG tree.
- `artifact-store`: separate agent upload and browser download endpoints.

## Impact

- `packages/orchestration/src/activities/{runner,harness}.ts`, `src/workflows/stage.ts`,
  `src/artifact-store.ts`.
- `apps/api/src/runs.ts`, `compose.yaml`, `.env.example`.
- `packages/runners/src/{local,agent,agent-runtime,opencode-config}.ts`.
- `packages/adapters/src/{adapter,opencode}.ts`.
- Tests in adapters, runners and orchestration; README/STATUS/DECISIONS.
