# Tasks

## 1. Worker can run Docker (`packages/orchestration/Dockerfile`)

- [x] 1.1 Install `docker-ce-cli` from Docker's Debian repo (arch via `dpkg --print-architecture`)
- [x] 1.2 Verify inside the worker: `docker version` succeeds and the socket is usable
- [x] 1.3 `docker compose up -d --build worker`; confirm `factory-runner:local` can be inspected/built

## 2. Cause-preserving failures (`packages/orchestration`)

- [x] 2.1 `describeFailure(error)`: walk `cause` chain, collect code + messages, collapse duplicates
- [x] 2.2 Use it for `failure`, the `workflow-error` step and the terminal summary
- [x] 2.3 Unit tests: plain Error, nested cause, Temporal-shaped ActivityFailure, duplicate messages

## 3. Run page (`apps/web`)

- [x] 3.1 Meta grid: short SHA + full value in `title`/copy, `min-w-0`, no overlap at 1280px and narrower
- [x] 3.2 Failure panel for `error`: message, code, failed steps, workflow id, Temporal UI link
- [x] 3.3 Remediation hints: `docker_unavailable`, `model_unresolved`, `runner_unavailable`,
      `permission_timeout`; generic fallback otherwise
- [x] 3.4 Cancelled: reason + actor; `ok`: no panel

## 4. Proof

- [x] 4.1 Rebuild worker, send a chat to `best_llm` through opencode, assert the run reaches `ok`
      (real model path, not fake)
- [x] 4.2 Playwright: existing failed run shows the failure panel with workflow id + Temporal link; meta cells
      do not overlap (bounding boxes)
- [x] 4.3 `bun run ci`, smoke, Playwright, UI audit green
- [x] 4.4 STATUS + `openspec validate fix-run-failures`
