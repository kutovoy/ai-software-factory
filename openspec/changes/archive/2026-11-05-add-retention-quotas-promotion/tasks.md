# Tasks

## 1. Retention core

- [x] 1.1 Add retention config (`RETENTION_ENABLED`, `RETENTION_DAYS`, `RETENTION_KEEP_RUNS`,
  `RETENTION_SWEEP_INTERVAL_MS`, `RETENTION_DRY_RUN`) to API and orchestration config.
- [x] 1.2 Implement `sweepFactoryRetention` / `sweepRetention`: select terminal runs older than
  the cutoff beyond keep-N, delete `run_secrets`/`score_runs`/runs (cascades events), remove
  `runs/<id>/`, delete stored artifacts, and prune terminal canary trees.
- [x] 1.3 Add presigned DELETE and `deleteStoredObject` to the artifact store.
- [x] 1.4 Run the sweep from the worker on `RETENTION_SWEEP_INTERVAL_MS`; never run on remote
  hosts.
- [x] 1.5 Unit tests for selection/protection/dry-run and artifact deletion.

## 2. Manual GC

- [x] 2.1 Add `POST /api/v1/factories/{factoryId}/runs/gc` with actor/reason/days/keep/dryRun.
- [x] 2.2 Add a Runs-page GC control; keep the existing canary prune control.
- [x] 2.3 OpenAPI + help entries for both manual controls.

## 3. Cost and quota controls

- [x] 3.1 Extend the `budget` schema with `maxCostUsdPerDay`, `maxCostUsdPerMonth`,
  `maxConcurrentRuns`.
- [x] 3.2 Add spend-window and active-run queries; enforce at run and work-item admission with
  `factory_budget_exhausted` / `factory_quota_exhausted`.
- [x] 3.3 Extend `GET /factories/{factoryId}/budget` with day/month/concurrency state.
- [x] 3.4 Add a dashboard budget/quota panel and update types/help.
- [x] 3.5 Unit tests for window spend, exhaustion and concurrency admission.

## 4. Promotion local checkout

- [x] 4.1 After a canary merge, rewrite the local factory tree and commit it on the definition
  repo when the checkout is clean.
- [x] 4.2 Fall back to `promotion_pending_deploy` with a reason when the checkout is dirty or
  not a git worktree; keep the optional `deployHook` path.
- [x] 4.3 Record the local commit and checkout outcome in rollout evidence and the
  `canary.promoted` event.
- [x] 4.4 Tests for clean rewrite, dirty refusal, no-git fallback and hook precedence.

## 5. Verification and docs

- [x] 5.1 `bun run typecheck`, targeted tests and `bun run ci`.
- [x] 5.2 `openspec validate` passes; archive after verification.
- [x] 5.3 Update README `What's new`, STATUS, DECISIONS, compose env, `.env.example` and help.
