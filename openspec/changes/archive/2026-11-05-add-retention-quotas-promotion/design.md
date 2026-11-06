# Design

## Context

The platform now has durable run directories (`runs/<runId>/events.jsonl`, `patch.diff`,
`artifacts/`), Postgres projections, RustFS artifact blobs and materialised canary trees under
`runs/canary/<rolloutId>/definition`. None of these have a lifecycle policy. Budgets are
lifetime-only and concurrency is unbounded. Canary promotion merges the forge repo but leaves
the local checkout stale.

## Goals / Non-Goals

**Goals:**
- Bound disk/object-store growth without deleting active or newest evidence.
- Give operators a manual, auditable GC path for runs and canary trees.
- Enforce daily/monthly spend and concurrency quotas at admission.
- Make a promoted canary the definition the next local run executes.
- Keep every operation idempotent and safe to retry.

**Non-Goals:**
- Temporal history retention (owned by Temporal).
- Per-tenant quotas or multi-tenant isolation (Phase 6c).
- A general-purpose backup/restore system.
- Rewriting the local checkout when it is dirty or not a git worktree.

## Decisions

- **Retention is conservative.** Only terminal runs (`ok`, `error`, `cancelled`) older than
  `RETENTION_DAYS` are candidates, and the newest `RETENTION_KEEP_RUNS` per factory are always
  kept. Active/pending/running runs are protected. The sweep is idempotent: a retry deletes
  nothing that is already gone.
- **Delete DB rows first, then blobs/directories.** The database is the source of truth; a
  failed file deletion leaves an orphan that the next sweep retries. `run_secrets` and
  `score_runs` are deleted explicitly because they have no cascade from `runs`.
- **Object deletion is best-effort.** The artifact store gains a presigned `DELETE`; a
  transport failure is reported but does not roll back the DB delete. RustFS lifecycle rules
  remain the backstop.
- **Worker-owned schedule.** Retention runs in the worker next to the runner reaper and
  observability sweeps. Remote hosts never run it. `RETENTION_ENABLED=0` disables it.
- **Manual route is factory-scoped.** `POST /api/v1/factories/{factoryId}/runs/gc` takes
  `actor`, `reason`, optional `days`, `keep` and `dryRun`; it returns counts and errors. The
  same core function powers the worker sweep.
- **Quota admission.** `maxCostUsdPerDay`, `maxCostUsdPerMonth` and `maxConcurrentRuns` join
  the existing `budget` block. New runs and work items are refused with
  `factory_budget_exhausted` (spend) or `factory_quota_exhausted` (concurrency). The budget
  endpoint reports lifetime, day, month and concurrency state.
- **Promotion rewrites the local checkout.** After a successful forge merge, copy the
  candidate tree into the factory directory and commit it on the local definition repo.
  If the checkout is dirty or not a git worktree, record `promotion_pending_deploy` with the
  reason instead of overwriting user work. A configured `deployHook` still runs afterwards;
  its success records `deployed`.
- **Audit.** Retention writes a structured log line per sweep and per manual GC; canary tree
  removals keep the existing `canary.gc` event. Promotion records the local commit in rollout
  evidence.

## Risks / Trade-offs

- [Risk] Deleting old runs removes evidence used by scoring/benchmarks → Mitigation: keep the
  newest N and make age/keep configurable; benchmarks can pin a recording.
- [Risk] Local checkout rewrite could overwrite uncommitted operator changes → Mitigation:
  refuse when the factory path is dirty; record the reason.
- [Risk] Quota checks race under concurrent creates → Mitigation: concurrency is an admission
  guard, not a hard distributed lock; the worker still bounds execution.
- [Risk] Object-store delete failures leave orphans → Mitigation: best-effort, logged, and
  RustFS lifecycle rules are the final backstop.
