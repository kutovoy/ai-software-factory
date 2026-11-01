# `@factory/runners`

Sandbox leasing and tool execution, isolated from the API process. The API/worker never
spawns a shell: every command and every harness tool call runs inside a leased runner.

Two backends implement one protocol:

| Backend | Use | Isolation |
|---|---|---|
| `DockerRunnerBackend` | real runs, integration tests | container per run, workspace bind-mounted, harness inside |
| `LocalRunnerBackend` | fast tests, dev machines without Docker | host process (dev fallback, **not** a security boundary) |

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
- `LocalRunnerBackend` is the no-Docker path. It spawns the harness detached (so `kill`
  takes the whole process group), strips inference credentials from the inherited env, and
  picks a free `127.0.0.1` port. It does **not** apply `sandbox-exec` yet: treat it as a dev
  convenience, not isolation.
- `docker build` for the runner image needs network access and a few minutes on first use.

## Tests

- `bun test` — protocol/secret tests and the local backend end-to-end
  (lease → exec `echo hi` → artifacts → kill).
- `RUN_SLOW=1 bun test` — the docker integration test (builds the image, leases a container,
  runs `echo hi`, checks no inference env leaked, collects artifacts, kills twice).

---

Part of **Software Factory** — created by Nick Kutovyy. See the repository `NOTICE` for attribution.
