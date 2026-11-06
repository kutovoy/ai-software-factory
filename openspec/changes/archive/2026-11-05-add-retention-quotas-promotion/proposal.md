# Proposal

## Why

Four operational follow-ups remain after the runner and artifact work:

1. Run directories, event rows, artifact blobs and canary trees grow without bound. There is
   no automatic retention sweep and no manual run GC endpoint; only candidate trees can be
   pruned from the canary panel.
2. Spend caps exist per run, per stage and lifetime-per-factory, but there is no daily or
   monthly quota and no concurrency limit. A factory can exhaust its lifetime budget in one
   day, and chat + stage runs can oversubscribe the worker.
3. Promoting a canary merges the definition repo but leaves the local checkout on the old
   definition. The next run therefore executes stale code until someone manually pulls.
4. `runs/canary/` cleanup is manual or only triggered by promotion/rollback; an operator has
   no scheduled safety net and no audit trail for retention work.

## What Changes

- Add a **retention/GC** subsystem: configurable run age, keep-N-per-factory, dry-run,
  artifact-store object deletion, run-directory removal, DB row cleanup and canary-tree
  pruning. Run it from the worker on an interval and expose a factory-scoped manual run GC
  route.
- Add **cost/quota controls**: per-factory daily and monthly spend caps and a concurrent-run
  quota in `factory.yaml`; admission checks for new runs and work items; a richer budget
  endpoint and a dashboard quota panel.
- Add **local-checkout promotion**: after a canary merge, rewrite the local definition
  checkout and commit the promoted tree; fall back to the existing pending-deploy state when
  the checkout cannot be updated safely. The optional `deployHook` still runs afterwards.
- Add **manual runs/canary GC** to the console: a Runs-page GC control and the existing canary
  prune control, both auditable and dry-runnable where applicable.
- Update OpenAPI, help, README, STATUS, DECISIONS, compose env and tests.

## Capabilities

### New Capabilities

- `retention`: automatic and manual garbage collection for terminal runs, event rows, run
  directories, artifact blobs and canary candidate trees.
- `quotas`: per-factory spend windows and concurrent-run admission control.

### Modified Capabilities

- `self-improvement`: canary promotion rewrites the local checkout by default and records
  the checkout commit.
- `web-console`: Runs-page manual GC, canary prune and a budget/quota panel.

## Impact

- `packages/orchestration/src/retention.ts`, `artifact-store.ts`, `s3-presign.ts`,
  `worker.ts`, `config.ts`, `activities/persist.ts`.
- `packages/core/src/schema/factory.ts`, `packages/core/migrations/023_retention_quotas.sql`.
- `apps/api/src/retention.ts`, `runs.ts`, `app.ts`, `openapi.json`, `errors.ts`.
- `apps/web/src/app/factories/[id]/runs/page.tsx`, dashboard, help and types.
- `packages/orchestration/src/canary-apply.ts` and its tests.
- `compose.yaml`, `.env.example`, README, STATUS, DECISIONS.
