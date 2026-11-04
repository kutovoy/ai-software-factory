# Performance Plan — Read-Path Latency

Status: **implemented (Phases 1–6) and verified**
Measured: 2026-11-03 (baseline) and 2026-11-04 (after) against the local compose stack
(`api`, `worker`, `web`, Postgres, Temporal).

## Why this exists

`/chat` and `/inbox` were reported at 4s+. Measurements on the current stack show the inbox at
~7s and the work-items board at ~3.5–4s. The database queries are fast; the cost is repeated
factory-registry synchronization, N+1 detail reads, synchronous git subprocesses and duplicate
page/layout reads.

This plan is deliberately written as a scalable fix plan, not a local micro-optimisation.

## Measured baseline

Warm requests, current compose stack:

| Route | Latency | API calls made by the page |
|---|---:|---:|
| `/chat` | 0.49–0.89s | 3 |
| `/inbox` | **6.97–7.20s** | **~112** |
| `/factories/<id>/work-items` | **3.49–4.05s** | **43** |
| `/factories/<id>/dashboard` | 1.33–1.37s | ~10 |

API timings:

| API route | Latency |
|---|---:|
| `GET /factories` | 0.24–0.83s |
| `GET /factories/:id` | 0.22–0.28s |
| `GET /factories/:id/runs?limit=100` | 0.90–4.60s |
| `GET /factories/:id/work-items?limit=100` | 0.40–1.37s |
| `GET /factories/:id/work-items/:id` | 0.12–0.38s |
| `GET /factories/:id/runs/:id` | 0.12–0.14s |

Direct measurements inside the API container:

- `syncFactoryRegistry`: **253ms**
- `resolveFactory`: **194ms**
- `createVersion` per factory: **39–131ms**
- `loadDefinition` per factory: **16–72ms**
- Main work-item/run SQL plans: **0.1–1ms**

Data volume at the time of measurement: 2,937 runs, 674 work items, 88 pending gates, 1,882 pending
permissions. The SQL is not the bottleneck.

## Measured after implementation

Same compose stack, same data, warm requests (curl, admin session):

| Route | Before | After |
|---|---:|---:|
| `/chat` | 0.49–0.89s | **0.008s** |
| `/inbox` | 6.97–7.20s | **0.019–0.023s** |
| `/factories/<id>/work-items` | 3.49–4.05s | **0.016s** |
| `/factories/<id>/dashboard` | 1.33–1.37s | **0.105–0.152s** |

API timings:

| API route | Before | After |
|---|---:|---:|
| `GET /factories` | 0.24–0.83s | **0.002s** warm (0.13s on the once-per-TTL sync) |
| `GET /factories/:id` | 0.22–0.28s | **0.002s** |
| `GET /factories/:id/work-items?view=board&limit=40` | n/a (43 calls) | **0.004–0.017s** |
| `GET /factories/:id/runs?limit=100` | 0.90–4.60s | **0.002–0.005s** |
| `GET /factories/:id/work-items?limit=100` | 0.40–1.37s | **0.002–0.003s** |
| `GET /inbox?limit=50` | n/a (~112 calls) | **0.006–0.019s** |

`resolveFactory` is now ~1ms (was ~194ms); the full registry sync is ~138ms and runs at most
once per `FACTORY_REGISTRY_TTL_MS` (default 60s), not per request.

## Root causes

### 1. Every factory-scoped request re-syncs the entire registry

`apps/api/src/app.ts:347` resolves every nested route through `resolveFactory`, which calls
`syncFactoryRegistry` (`apps/api/src/factories.ts:451`). That sync scans every factory directory,
loads every definition, runs `createVersion` per factory, and upserts registry rows.

`createVersion` (`packages/core/src/version/version.ts:24`) uses `execFileSync` for three git
commands and loads the definition again for the content hash. So one registry sync is roughly:

- 4 definition loads;
- 12 synchronous git subprocesses;
- 4 registry `delete` + `insert` writes.

An inbox render makes ~112 API calls, each of which re-syncs the registry: roughly 448 definition
loads, 1,344 git subprocesses and 448 registry writes. That is the primary 7s cost.

### 2. N+1 detail reads

`apps/web/src/app/inbox/page.tsx` fetches:

- `/factories`;
- runs and work items for every factory;
- a run detail for every open/failed run;
- a work-item detail for **every non-done/non-cancelled item**.

With current data that is ~112 API calls: 8 list calls, 13 run details and 89 work-item details.
Most of the 89 work-item details have no pending gate; the inbox only needs the pending gate row.

`apps/web/src/app/factories/[id]/work-items/page.tsx` does the same for the board: list, then one
detail call per visible card (up to 40), even though the board only needs the summary and pending
gate.

### 3. Duplicate layout/page reads

`apps/web/src/app/layout.tsx` calls `/factories` on every page; `/chat` and `/inbox` call
`/factories` again in their own server components. `/chat` pays three factory-related calls:
layout list, page list and page detail.

### 4. Synchronous git blocks the API event loop

`execFileSync` blocks the process while git runs. Concurrent server-side requests cannot get clean
parallelism; they queue behind synchronous git work. This matches the 0.9–4.6s variance on
`/runs?limit=100` even though its SQL is under 1ms.

### 5. Session writes on every API call

`packages/core/src/auth/repository.ts:263` updates `sessions.last_seen_at` on every authenticated
request. The inbox therefore performs ~112 session writes on top of the registry writes.

### 6. Sequential inbox barriers

The inbox waits for factory lists, then all per-factory lists, then all run details, then all
work-item details. Each phase waits for the slowest request before starting the next.

## Scalable fix plan

The plan is ordered by impact and scalability. Each item includes the grounding for the pattern.

### Phase 0 — Instrument and lock a baseline

- Add OpenTelemetry spans around `resolveFactory`, `syncFactoryRegistry`, `getFactory`,
  `listWorkItems`, `listRuns`, the inbox projection and the board projection.
- Track p50/p95/p99, query count per page, cache hit ratio and Node event-loop delay.
- Add a k6 smoke/load profile with p95 thresholds.
- Use `pg_stat_statements` and `EXPLAIN (ANALYZE, BUFFERS)` for the inbox/board queries.

Grounding: k6 p95/p99 thresholds <https://qaskills.sh/blog/k6-load-testing-p95-p99-guide>,
k6 + OpenTelemetry traces <https://oneuptime.com/blog/post/2026-02-06-k6-load-test-opentelemetry-traces/view>.

Acceptance: a repeatable baseline report exists before any fix; no fix is judged by a single request.

### Phase 1 — Remove registry sync from the read path (P0)

- Treat the `factories` table as the read model, not a per-request cache rebuild.
- Add registry read-model columns: `definition_commit`, `content_hash`, `dirty`, `tag`,
  `resource_count`, `repo_count`, `valid`, `error_count`, `synced_at`, `alias`.
- `listFactories` becomes one SQL query over `factories`, not a filesystem scan.
- `resolveFactory` queries `factories` by primary key `id` and checks owner scope; it falls back to
  `syncFactoryRegistry` only on a cache miss.
- Run `syncFactoryRegistry` from a background refresh (Temporal schedule or admin refresh) or on
  explicit factory mutations, not every read.
- Cache parsed definitions and versions keyed by `(dir, commit)`; compute `contentHash` at sync time,
  not on every read.
- Replace `execFileSync` with async `execFile`; use `git rev-parse HEAD` once per repo and
  `git diff-index --quiet HEAD -- .` for dirty detection instead of `git status`.
- Batch registry upserts into one `INSERT ... ON CONFLICT` statement instead of per-row delete/insert.
- Add a request-scoped cache/DataLoader for factory resolution so one page render does not repeat
  the same lookup.

Grounding: CQRS/materialized read model
<https://learn.microsoft.com/en-us/azure/architecture/patterns/cqrs>, cache-aside
<https://redis.io/docs/latest/develop/use-cases/cache-aside/>, async child processes
<https://nodejs.org/api/child_process.html>, event-loop blocking
<https://www.cubic.dev/agents/nodejs-event-loop-blocking>, git performance
<https://www.git-tower.com/blog/git-performance> and lower-level git diff
<https://unix.stackexchange.com/questions/519371/why-does-executing-git-status-change-the-result-of-subsequent-git-diff-index>.

Acceptance:

- Warm `resolveFactory` p95 < 10ms.
- Zero `syncFactoryRegistry` calls on `/chat`, `/inbox`, `/work-items` and `/dashboard`.
- Registry invalidation is visible within the configured TTL or immediately on factory mutation.
- No synchronous git call in an API request path.

### Phase 2 — Add batch read projections (P0)

- Add `GET /api/v1/inbox` returning pending gates, pending permissions and failed runs in one
  response, with factory id/name, title, commit, requested time, SLA, action/request id and error.
- Use one query per category (or a `UNION ALL`) with the existing partial indexes and owner scope.
- Add `GET /factories/:id/work-items?view=board&limit=40&cursor=...` with a lateral join for the
  newest pending gate and optional run references.
- Add a lightweight `view=summary` for work-item detail; inbox/board must not fetch full event logs.
- Add cursor pagination to inbox, work items and runs; do not fetch 100 items per factory to filter
  in application code.
- Keep the full detail endpoints for the detail pages.

Grounding: BFF/aggregation
<https://learn.microsoft.com/en-us/azure/architecture/patterns/backends-for-frontends>,
N+1/DataLoader <https://www.graphql-js.org/docs/n1-dataloader/>, cursor pagination
<https://developer.zendesk.com/documentation/api-basics/pagination/paginating-through-lists-using-cursor-pagination/>.

Acceptance:

- `/inbox` makes at most 2–3 API calls and executes a constant number of SQL queries.
- `/work-items` board makes at most 3 API calls and no per-card detail calls.
- Inbox/board p95 < 500ms with the same data volume.
- Pagination is cursor-based and stable under inserts.

### Phase 3 — Request memoization and caching (P1)

- Wrap factory-list and factory-detail reads in React `cache()` so the layout and page share one
  request-level fetch.
- Add Next.js `unstable_cache` (or the project's cache abstraction) for read-only factory metadata,
  keyed by viewer scope where needed, with `revalidateTag('factories')` on mutations.
- Cache definitions/versions in-process by `(dir, commit)`; invalidate on sync.
- For multi-instance deployments, use a shared cache handler (Redis/Valkey) rather than a
  process-local cache. Cache only viewer-safe data; keep member-specific inbox data private.
- Add `ETag`/`If-None-Match` and `Cache-Control: private, max-age=5, stale-while-revalidate=30`
  to read-only API projections where staleness is acceptable.

Grounding: React `cache` and Next.js request memoization
<https://nextjs.org/docs/app/guides/caching-without-cache-components>, Next.js data fetching
<https://nextjs.org/docs/app/getting-started/fetching-data>, self-hosting/cache handler
<https://nextjs.org/docs/app/api-reference/config/next-config-js/incrementalCacheHandlerPath>,
shared Next.js cache <https://github.com/vercel/next.js/discussions/91824>, HTTP caching
<https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Cache-Control> and
<https://web.dev/articles/http-cache>.

Acceptance:

- Layout + page factory-list fetch is one request.
- Cache hit ratio > 90% for factory metadata under steady load.
- Invalidation is tag/event-driven; TTL is a fallback, not the only mechanism.
- No shared cache entry contains member-private inbox data or secrets.

### Phase 4 — Session and auth read path (P1)

- Throttle `last_seen_at`: update only when older than a configured interval (e.g. 5 minutes), or
  move the touch to a background task.
- Add a short-TTL session→user cache (process-local for one instance; Redis for multi-instance),
  invalidated on logout/revocation.
- Keep the session token hash lookup indexed and avoid writes on read-only API calls.

Grounding: Redis session management <https://redis.io/solutions/session-management/>, IBM Redis
session cache <https://www.ibm.com/docs/en/sva/11.0.2?topic=overview-redis-session-cache-process-flow>.

Acceptance:

- Read-only API calls do not write to `sessions` on every request.
- Session revocation is effective within the cache TTL.
- No auth regression in the existing integration tests.

### Phase 5 — Database indexes and query shape (P2)

Add these only after Phase 1/2, and verify with `EXPLAIN (ANALYZE, BUFFERS)`:

- `runs (factory, started_at desc)`
- `work_items (factory, created_at desc)`
- `work_items (factory, status, created_at desc)`
- `runs (factory, status, started_at desc)`
- partial `gate_decisions (requested_at desc) where decision is null`
- partial `run_permissions (requested_at desc) where decision is null`

Use `CREATE INDEX CONCURRENTLY` in production. Keep the existing primary keys and partial indexes;
avoid redundant indexes. Confirm connection-pool sizing for Bun SQL.

Grounding: PostgreSQL `CREATE INDEX`
<https://www.postgresql.org/docs/current/sql-createindex.html>, composite/partial index guidance
<https://bigdataboutique.com/blog/postgresql-indexes-best-practices>,
<https://www.mydbops.com/blog/postgresql-indexing-best-practices-guide>, concurrent index creation
<https://devcenter.heroku.com/articles/postgresql-indexes>, Bun SQL
<https://bun.com/docs/runtime/sql>.

Acceptance:

- Query plans use index scans and index-only scans where expected.
- No sequential scan on large tables in the inbox/board paths.
- p95 stays within target at 10x current data volume in a synthetic dataset.

### Phase 6 — Streaming and perceived latency (P2)

- Add `loading.tsx` and Suspense boundaries for `/inbox` and the work-items board so the shell and
  headings render immediately while the projections stream.
- Keep skeletons honest: no fake counts or fabricated rows.
- Use the batch projections from Phase 2 as the data source; streaming is a UX layer, not a
  substitute for fixing the backend.

Grounding: Next.js streaming
<https://nextjs.org/learn/dashboard-app/streaming>, loading/Suspense guide
<https://dev.to/boopykiki/a-complete-nextjs-streaming-guide-loadingtsx-suspense-and-performance-9g9>.

Acceptance:

- First contentful paint is not blocked by inbox/board data.
- The page shows a real loading state, not an empty shell that looks like “no work”.
- The full data still arrives within the p95 target.

## Implementation status

The fix phases (1–6) are implemented; Phase 0's repeatable benchmark is in place, with
k6/OpenTelemetry left as an optional load/trace layer:

- **Phase 1 — registry read model.** Migration `018_factory_registry_read_model.sql` adds
  version/resource columns to `factories`. `listFactories` and `resolveFactory` read one
  indexed row; `syncFactoryRegistry` is single-flight, TTL-bounded and only runs on a stale
  registry or a miss. `createVersionAsync` uses async `git` and `git diff-index`, and the
  registry upsert writes the read-model columns.
- **Phase 2 — batch projections.** `GET /api/v1/inbox` returns pending gates, permissions
  and failed runs in one owner-scoped projection. `GET /api/v1/factories/:id/work-items?view=board`
  returns summaries, pending gates, run-link events, status counts and a keyset cursor in
  one query. The inbox and board pages use these endpoints; no per-card detail calls remain.
- **Phase 3 — request memoization.** `getFactoryList` and `getFactoryDetail` are wrapped in
  React `cache()`; the layout, chat and factory pages share one upstream read per render.
  Definition loading has a short commit-keyed cache. The API stays authoritative and
  viewer-scoped; no shared cache is used for member-private data.
- **Phase 4 — session throttle.** `findSessionUser` only writes `last_seen_at` when it is
  older than five minutes, so a 112-call inbox render no longer performs 112 session writes.
- **Phase 5 — indexes.** Migration `019_read_path_indexes.sql` adds the composite/partial
  indexes for factory-scoped run/work-item lists and the pending gate/permission queues.
- **Phase 6 — streaming.** `loading.tsx` files for `/inbox` and the work-items board render
  honest skeletons while the batch projection streams.
- **Repeatable benchmark.** `scripts/perf-read-path.sh` (also `bun run perf:read-path`) signs
  in, warms the registry and measures the API and console routes against the SLOs above. It is
  dependency-free; k6/OpenTelemetry can be layered on later for load and trace profiles.

## Target SLOs

After Phases 1–3:

| Surface | Target p95 |
|---|---:|
| `/chat` warm | < 300ms |
| `/inbox` | < 500ms |
| `/work-items` board | < 500ms |
| `/dashboard` | < 700ms |
| `resolveFactory` | < 10ms |
| API read projections | < 50ms server time |

Also track: API calls per page (constant, not O(n)), SQL queries per page (constant), cache hit ratio,
event-loop delay and error rate.

## What not to do

- Do not add more parallel detail calls before fixing the synchronous git/registry path; the API
  event loop is the constraint, and more concurrency can make variance worse.
- Do not start with database indexes; the measured SQL is already 0.1–1ms. Fix the read path first.
- Do not put member-specific inbox data or secrets in a shared CDN/Redis cache without viewer-scoped
  keys and invalidation.
- Do not rely on a process-local cache for multi-instance deployments; use the DB read model plus a
  shared cache handler where needed.
- Do not make the UI cache the source of truth for definitions; git remains authoritative.

## Verification plan

1. Capture baseline with `scripts/perf-read-path.sh` (and k6/OpenTelemetry for a load profile).
2. Implement Phase 1 behind a feature flag (`FACTORY_REGISTRY_CACHE`); compare p95 and query counts.
3. Add Phase 2 endpoints and switch the inbox/board pages; keep the old path as a fallback until
   parity tests pass.
4. Add Phase 3 request memoization/caching; verify invalidation on factory mutation.
5. Add Phase 4 session throttling; verify logout/revocation.
6. Add Phase 5 indexes with `CONCURRENTLY`; compare `EXPLAIN` before/after.
7. Add Phase 6 streaming; verify no fabricated empty states.
8. Run the existing `bun run ci`, smoke, Playwright and the new k6 profile; record p95/p99 and query
   counts in `docs/STATUS.md`.

## References

- Next.js caching and revalidation:
  <https://nextjs.org/docs/app/guides/caching-without-cache-components>
- Next.js data fetching:
  <https://nextjs.org/docs/app/getting-started/fetching-data>
- Next.js self-hosting and custom cache handler:
  <https://nextjs.org/docs/app/guides/self-hosting>,
  <https://nextjs.org/docs/app/api-reference/config/next-config-js/incrementalCacheHandlerPath>
- Shared Next.js cache discussion:
  <https://github.com/vercel/next.js/discussions/91824>
- N+1 and DataLoader:
  <https://www.graphql-js.org/docs/n1-dataloader/>
- BFF/aggregation:
  <https://learn.microsoft.com/en-us/azure/architecture/patterns/backends-for-frontends>
- CQRS/materialized read model:
  <https://learn.microsoft.com/en-us/azure/architecture/patterns/cqrs>
- Cache-aside:
  <https://redis.io/docs/latest/develop/use-cases/cache-aside/>
- Redis sessions:
  <https://redis.io/solutions/session-management/>
- Node child processes and event loop:
  <https://nodejs.org/api/child_process.html>,
  <https://www.cubic.dev/agents/nodejs-event-loop-blocking>
- Git performance:
  <https://www.git-tower.com/blog/git-performance>,
  <https://unix.stackexchange.com/questions/519371/why-does-executing-git-status-change-the-result-of-subsequent-git-diff-index>
- PostgreSQL indexes:
  <https://www.postgresql.org/docs/current/sql-createindex.html>,
  <https://bigdataboutique.com/blog/postgresql-indexes-best-practices>,
  <https://www.mydbops.com/blog/postgresql-indexing-best-practices-guide>
- HTTP caching:
  <https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Cache-Control>,
  <https://web.dev/articles/http-cache>
- Cursor pagination:
  <https://developer.zendesk.com/documentation/api-basics/pagination/paginating-through-lists-using-cursor-pagination/>
- k6 p95/p99:
  <https://qaskills.sh/blog/k6-load-testing-p95-p99-guide>
- k6 + OpenTelemetry:
  <https://oneuptime.com/blog/post/2026-02-06-k6-load-test-opentelemetry-traces/view>
- Bun SQL:
  <https://bun.com/docs/runtime/sql>
