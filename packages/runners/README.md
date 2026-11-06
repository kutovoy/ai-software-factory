# `@factory/runners`

Sandbox leasing and tool execution, isolated from the API process. The API/worker never
spawns a shell: every command and every harness tool call runs inside a leased runner.

Three backends implement one protocol:

| Backend | Use | Isolation |
|---|---|---|
| `DockerRunnerBackend` | real runs, integration tests | container per run, workspace bind-mounted, harness inside |
| `LocalRunnerBackend` | fast tests, dev machines, Windows/macOS runner hosts | host process (not a security boundary; `sandbox-exec` on macOS, PowerShell on Windows) |
| `RemoteRunnerBackend` | remote hosts | agent command queue; the agent owns a Docker sandbox on Linux or a native process sandbox on Windows/macOS |

## Remote runner agent

`packages/runners/src/agent.ts` is the remote agent. It enrolls once from the console with a
one-time token, stores the returned agent token, then heartbeats CPU/RAM/disk metrics and polls
`/api/v1/runner-agent/commands` over outbound HTTP(S). It never runs a Temporal worker and never
connects to Postgres.

Platforms and default backends:

| Platform | `RUNNER_PLATFORM` | Default `RUNNER_BACKEND` | Sandbox |
|---|---|---|---|
| Linux | `linux` | `docker` | container per run (`agent.Dockerfile`) |
| Windows | `windows` | `local` | native PowerShell process, `taskkill /t` tree kill |
| macOS | `macos` | `local` | native process, `sandbox-exec` when `RUNNER_SANDBOX=exec` |

An explicit `RUNNER_BACKEND`/`--backend` always wins. The generated install command sets it, so
an operator never has to guess.

The agent executes `lease`, `exec`, `start-session`, `pump`, `respond-permission`,
`artifacts`, `cancel`, `kill` and `smoke-test` commands. It runs the harness adapter
locally and streams canonical events back to the central worker, which remains the only
writer of the event log. The agent receives only the per-run proxy token; provider keys
never leave the central API/worker.

### Linux (Docker)

Build the Linux agent image from the repository root:

```bash
docker build -t factory-runner-agent:local -f packages/runners/agent.Dockerfile .
docker run -d --name factory-runner-agent \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v factory-runner-data:/data \
  -e FACTORY_API_URL=https://factory.example.com \
  -e RUNNER_ENROLLMENT_TOKEN=... \
  -e RUNNER_STATE_FILE=/data/runner-agent.json \
  -e RUNNER_WORKSPACE_MODE=copy \
  factory-runner-agent:local
```

### Windows (native PowerShell)

Run from a checkout of this repository in PowerShell (the console generates the same script with
the enrollment token filled in):

```powershell
$env:FACTORY_API_URL = 'https://factory.example.com'
$env:RUNNER_ENROLLMENT_TOKEN = '...'
$env:RUNNER_STATE_FILE = "$env:LOCALAPPDATA\factory-runner\runner-agent.json"
$env:RUNNER_PLATFORM = 'windows'
$env:RUNNER_BACKEND = 'local'
# Bun is required; the generated install script installs it when missing.
bun packages/runners/src/agent.ts
```

The agent's local backend uses `powershell.exe -NoProfile -NonInteractive -Command`, quotes
array commands PowerShell-style (`& 'cmd' 'arg'`) and terminates the process tree with
`taskkill /pid <pid> /t /f`. Metrics come from PowerShell/CIM (`Win32_Processor`,
`Win32_OperatingSystem`, `Win32_LogicalDisk`, `Get-Process`); a failing query degrades the
sample instead of failing the heartbeat. A Windows service wrapper is a follow-up — the
generated install command starts the agent hidden with `Start-Process` and writes a pid file.

### macOS (native)

Run from a checkout of this repository:

```bash
export FACTORY_API_URL='https://factory.example.com'
export RUNNER_ENROLLMENT_TOKEN='...'
export RUNNER_STATE_FILE="$HOME/.factory-runner/runner-agent.json"
export RUNNER_PLATFORM='macos'
export RUNNER_BACKEND=local
export RUNNER_SANDBOX=exec   # generated install command sets this
nohup bun packages/runners/src/agent.ts >>"$HOME/.factory-runner/agent.log" 2>&1 &
```

Swap comes from `sysctl -n vm.swapusage`, process count from `ps -e`; a missing `sysctl`/`df`
value degrades without failing the heartbeat. A launchd plist is documented as a follow-up.

Native macOS runs receive the runner `opencode.json` through `OPENCODE_CONFIG_CONTENT`; a
`sandbox-exec` lease also gets a per-run writable HOME/XDG tree for opencode state/cache.

**Live verification (2026-11-05):** macOS M5 native (`RUNNER_BACKEND=local`, `RUNNER_SANDBOX=exec`)
and Linux Docker agents on Docker Desktop both completed real opencode chat runs with RustFS artifact
upload/download and no provider key on the agent. See `docs/STATUS.md` for run IDs and fixes.

### Limitations

- Windows/macOS native runners are weaker isolation than a Linux container per run: use a
  dedicated VM or user for untrusted code (see `docs/REMOTE_RUNNERS_PLAN.md` §8).
- `patch.diff` is still returned inline; other artifact blobs are uploaded to the object store
  when it is configured (ADR-047) and otherwise stay on the runner host. `S3_ENDPOINT` is the
  agent-facing upload URL; `S3_PUBLIC_ENDPOINT` is the browser-facing download URL and defaults to it.
- The agent token is bearer-authenticated (deploy behind TLS; mTLS certificate fingerprinting is
  reserved, not built).

## Protocol

```ts
interface RunnerBackend {
  readonly kind: 'docker' | 'local';
  lease(spec): Promise<RunnerHandle>;          // → {runnerId, workspace, harnessUrl}
  exec(runnerId, req): AsyncIterable<ExecEvent>; // stdout/stderr/exit
  heartbeat(runnerId): Promise<RunnerHeartbeat>;
  artifacts(runnerId, req): Promise<Artifact[]>; // paths + sha256, never blobs
  kill(runnerId): Promise<void>;                // idempotent
}
```

Every call is idempotent and keyed by `runnerId` (Temporal activities retry). The default
`runnerId` is `factory-<runId>` sanitised, so a retried `lease` re-attaches to the existing
sandbox instead of creating a second one.

```ts
const handle = await backend.lease({
  runId: 'run_123',
  repo: { path: '/repos/acme', commit: '<full-sha>' },
  harness: { port: 4096, readyPath: '/api/info' },
  secrets: [{ name: 'GITHUB_TOKEN' }],
});

for await (const event of backend.exec(handle.runnerId, { command: 'bun test' })) {
  // {type:'stdout'|'stderr', data} … {type:'exit', code}
}
await backend.artifacts(handle.runnerId, {
  destDir: 'runs/run_123',
  paths: ['coverage/'],
  includeGitDiff: true,   // writes patch.diff
});
await backend.kill(handle.runnerId);
```

`ExecEvent` is `{type:'stdout'|'stderr', data}` then exactly one `{type:'exit', code}`;
failures yield `{type:'error', code, message}` (`exec_failed`, `exec_timeout` → exit 124,
`aborted` → exit 130, `runner_not_found`).

## Docker backend

`lease` does, in order:

1. validates the spec (`invalid_spec`) and resolves secrets (allowlist + inference ban);
2. checks the Docker server (`docker_unavailable`);
3. ensures the image (`factory-runner:local`, built from `docker/Dockerfile`: node 22,
   git, curl, opencode);
4. prepares the workspace — `git clone --no-checkout <repo>` + `checkout --detach <sha>`
   for a local repo, `git clone <url>` + checkout for a remote one;
5. `docker run -d` with the workspace at `/workspace`, `-p 127.0.0.1::4096` (ephemeral host
   port), labels `factory.runner` / `factory.run` / `factory.workspace`, granted secrets
   as `-e`, and the harness as `sh -c "<command>"`;
6. resolves the mapped port and polls the readiness path with exponential backoff. On
   timeout it captures `docker logs`, removes the container and fails with
   `runner_unavailable` (which the workflow maps to `status: error`).

`exec` uses `docker exec -i -w <cwd> <name> sh -c "<cmd>"`, streams output, kills the
process on timeout/abort and scrubs secret values from captured output.

`artifacts` writes `patch.diff` from the mounted workspace when `includeGitDiff` is set,
then `docker cp` each requested path into the run directory and hashes it (sha256).
Blobs stay on disk; Postgres stores only path + hash.

`kill` runs `docker rm -f` (ignoring "No such container"), removes the workspace unless
`keepWorkspace: true`, and is safe to call twice. The run directory is always retained.

## Secret boundary

Two gates, both must pass:

1. **Execution allowlist.** `allowedSecrets` defaults to
   `GITHUB_TOKEN`, `GH_TOKEN`, `GITLAB_TOKEN`, `NPM_TOKEN`, `SLACK_BOT_TOKEN`,
   `SLACK_WEBHOOK_URL`, `SENTRY_AUTH_TOKEN`, `LINEAR_API_KEY`. Anything else →
   `secret_not_granted`. Override per deployment.
2. **Inference ban.** Names matching `OPENAI_*`, `ANTHROPIC_*`, `AZURE_OPENAI*`, `GOOGLE_*`,
   `GEMINI_*`, `LITELLM_*`, `*_API_KEY`, `FACTORY_MODEL`, … are rejected with
   `inference_credential_forbidden` **even if allowlisted**. The same check runs over
   `spec.env` and `spec.harness.env`, so a credential cannot be smuggled in as plain env.

Values are resolved outside the sandbox (`resolveSecret`, env by default), injected only
for the run, and redacted from captured stdout/stderr (`scrubSecrets`). They are never
written to the event log.

**Known gap:** the harness runs *inside* the container, so it cannot reach a model without
credentials. Today the runner assumes the harness talks to an inference proxy or a local
model endpoint on the bridge network; wiring that proxy is Phase 2b work. Do not "fix" it
by injecting `OPENAI_API_KEY` — that is the exact boundary this package enforces.

## macOS notes

- Docker Desktop is required for the docker backend; `docker version` is checked on every
  lease and failures surface as `docker_unavailable`.
- Bind mounts work through the Docker VM; file ownership usually maps back to the host user,
  so `git diff` on the mounted workspace works for artifact capture.
- `LocalRunnerBackend` is the no-Docker path (and the macOS/Windows runner backend). It spawns
  the harness detached (so `kill` takes the whole process group), strips inference credentials
  from the inherited env, and picks a free `127.0.0.1` port. With `RUNNER_SANDBOX=exec` it runs
  the harness under a generated `sandbox-exec` profile: deny by default, read system + workspace,
  write only the workspace, the run directory and `/private/tmp`, no outbound network unless the
  stage grants it. Without it the process is unconfined — treat that as a dev convenience, not
  isolation.
- `docker build` for the runner image needs network access and a few minutes on first use.

## Tests

- `bun test` — protocol/secret tests, the local backend end-to-end
  (lease → exec `echo hi` → artifacts → kill) and platform tests (PowerShell argv/quoting,
  Windows CIM JSON and macOS `sysctl` metric parsing) that run without a Windows/macOS host.
- `RUN_SLOW=1 bun test` — the docker integration test (builds the image, leases a container,
  runs `echo hi`, checks no inference env leaked, collects artifacts, kills twice).

---

Part of **Software Factory** — created by Nick Kutovyy. See the repository `NOTICE` for attribution.
