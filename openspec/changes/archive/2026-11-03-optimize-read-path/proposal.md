# Proposal

## Why

The console's read path was dominated by repeated factory-registry synchronization and N+1
detail reads, not by SQL. On the compose stack, `/inbox` took ~7s (~112 API calls),
`/work-items` ~3.5–4s (43 calls) and `/chat` 0.5–0.9s, while the measured SQL plans were
0.1–1ms. Every factory-scoped request re-scanned the definition directories, ran synchronous
git and upserted the registry, so an inbox render repeated that work ~112 times and blocked
the API event loop.

## What Changes

- **Registry read model.** The `factories` table carries the version/resource metadata the
  console needs. `listFactories` and `resolveFactory` read one indexed row; the filesystem/git
  sync is single-flight, TTL-bounded and only runs on a stale registry or a miss.
- **Async git.** `createVersionAsync` uses async `git` and `git diff-index`; the registry
  computes version metadata once per sync, and definition loading is commit-keyed and cached.
- **Batch projections.** `GET /api/v1/inbox` returns pending gates, permissions and failed runs
  in one owner-scoped response. `GET /api/v1/factories/:id/work-items?view=board` returns
  summaries, newest pending gates, run-link events, status counts and a keyset cursor in one
  query. The inbox and board pages make one API call each.
- **Request memoization.** React `cache()` deduplicates the layout/page factory list and detail
  reads; no cross-request cache is used for viewer-scoped data.
- **Session throttle.** `last_seen_at` is written at most once per five minutes instead of on
  every authenticated request.
- **Indexes and streaming.** Read-path composite/partial indexes (migration 019) and honest
  `loading.tsx` skeletons for the inbox and board.

## Capabilities

### New Capabilities
- None.

### Modified Capabilities
- `read-model`: the factory registry is an explicit read model with a bounded sync.
- `http-api`: batch inbox projection, board projection and opaque keyset cursors.
- `web-console`: inbox/board batch reads, request-scoped memoization and loading states.

## Impact

- Migrations `018_factory_registry_read_model.sql` and `019_read_path_indexes.sql`.
- API: `apps/api/src/factories.ts`, `apps/api/src/inbox.ts`, `apps/api/src/work-items.ts`,
  `apps/api/src/app.ts`, `apps/api/src/cursor.ts`, `apps/api/src/config.ts`,
  `apps/api/openapi.json`.
- Core: async version creation, exported read-model mappers, session touch throttle.
- Web: `apps/web/src/lib/factories.ts`, inbox page, work-items board page, `loading.tsx` files.
- Tests: cursor unit test, inbox/board integration suite, full CI and Playwright.
- Docs: `docs/PERFORMANCE.md`, `docs/STATUS.md`, `docs/HANDOVER.md`, README and API help.

## Non-goals

- No Redis/shared cache in this change; the DB read model is the scalable source of truth.
- No change to run/work-item semantics, gate decisions or ownership rules.
- No new model calls, no fabricated UI data.
