# Tasks

## 1. Remote lease correctness

- [x] 1.1 Send only `url` for remote leases and fall back to `RUNNER_REPO_URL` for work-item stages.
  Verified by `packages/orchestration/test/runner-repo.test.ts` and live macOS/Linux runs.
- [x] 1.2 Do not send the central `/app/runs/...` path to remote agents; use an agent-local per-run
  sandbox directory. Verified by live macOS `sandbox-exec` run `run_mw3t7g4i_265452a4`.

## 2. Native harness and sandbox

- [x] 2.1 Carry `OPENCODE_CONFIG_CONTENT` in the harness command so native agents resolve
  `factory/best_llm`. Verified by `packages/orchestration/test/harness-command.test.ts` and the macOS
  live run.
- [x] 2.2 Rewrite the default harness port/hostname when the command has an env prefix. Verified by
  `packages/runners/test/local.test.ts`.
- [x] 2.3 Give macOS `sandbox-exec` leases a per-run writable HOME/XDG tree. Verified by
  `packages/runners/test/local.test.ts` and the macOS live run.
- [x] 2.4 Allow network for remote runs; local sandboxes keep the default denial. Verified by the
  macOS live run reaching the inference proxy.

## 3. Terminal state and shutdown

- [x] 3.1 Probe `session.outcome` on an idle pump and close failed sessions with the provider error.
  Verified by `packages/adapters/test/opencode.test.ts` and `packages/runners/test/agent.test.ts`.
- [x] 3.2 Reap live harness/sandbox children on agent shutdown. Verified by SIGTERM cleanup in both
  live runs (no surviving opencode child or sandbox container).

## 4. Artifact endpoints

- [x] 4.1 Add `S3_PUBLIC_ENDPOINT` for browser downloads while uploads use `S3_ENDPOINT`. Verified by
  `packages/orchestration/test/artifact-store.test.ts` and a plain host `curl -L` returning 200 for
  Linux run `run_mw3u0k5g_a1024e73`.

## 5. Live verification

- [x] 5.1 macOS M5 native agent with `RUNNER_BACKEND=local`, `RUNNER_SANDBOX=exec`: chat run
  `run_mw3t7g4i_265452a4` completed `ok`; sandbox active; artifact uploaded and downloaded.
- [x] 5.2 Linux Docker agent in Docker Desktop: chat run `run_mw3u0k5g_a1024e73` completed `ok`;
  sandbox container removed; artifact uploaded and downloaded through the public endpoint.
- [x] 5.3 Confirm no long-lived provider key on either agent. Verified by process/container env.
- [x] 5.4 `bun run ci`, `openspec validate --all` and Runners Playwright E2E pass.

## 6. Docs

- [x] 6.1 Update README `What's new`, STATUS, DECISIONS (ADR-047/048), `.env.example` and compose.
- [x] 6.2 Record the remaining follow-ups: separate remote host, Windows live verification, Windows
  containers, macOS Tart, mTLS and service wrappers.
