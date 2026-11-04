# Design

## Context

The console talks to the API only; every factory-scoped route resolves an opaque factory id
before doing work. The registry was derived from git on every read, which made the read path
O(number of API calls × number of factories × git operations). The fix keeps git authoritative
but moves derivation out of the request path.

## Decisions

### 1. The `factories` table is the read model, not a per-request cache rebuild

- Migration 018 adds `manifest_name`, `description`, `definition_commit`, `content_hash`,
  `dirty`, `tag`, `resource_count`, `repo_count`, `valid`, `error_count` and `synced_at`.
- `syncFactoryRegistry` remains the only writer. It is single-flight, runs at most once per
  `FACTORY_REGISTRY_TTL_MS` (default 60s), and is forced by a registry miss at most once per TTL.
- A stale row (`synced_at` null) is rebuilt once, so a pre-migration database or a fresh
  checkout still works.
- A failed database degrades to the filesystem projection, preserving unit tests and a fresh
  checkout.

### 2. Version metadata is computed asynchronously

- `createVersionAsync` uses `execFile` and `git diff-index --quiet HEAD -- .`; the registry
  passes the definition it already loaded to avoid a second load.
- The sync still uses the synchronous loader (one scan per TTL), not per request.
- `getFactory` accepts the registry version, so the detail route does not run git. Definition
  loading is cached by `(dir, commit)` for 30s.

### 3. Batch projections replace N+1 detail reads

- `GET /api/v1/inbox` runs three owner-scoped queries (pending gates, pending permissions,
  failed runs), each with `count(*) over()` for totals.
- `view=board` runs one work-item query with lateral joins for the newest pending gate and the
  `dispatch.requested` / `review.verdict` events, plus one status-count query.
- Both apply ownership in SQL: members see only their rows; admins see all.

### 4. Cursors are opaque keyset cursors

- A cursor is `(sort timestamp, id)`, base64url-encoded. It stays stable under inserts and
  avoids `OFFSET` drift. Invalid cursors are ignored and fall back to the first page.

### 5. Request memoization is viewer-scoped and request-scoped

- React `cache()` wraps `getFactoryList` and `getFactoryDetail`, so the layout and page share
  one upstream read in a render.
- No cross-request/shared cache is used for viewer-scoped data; the API remains authoritative.
- The API's definition cache is keyed by commit and is safe because it is derived from git.

### 6. Session writes are throttled, not cached

- `findSessionUser` updates `last_seen_at` only when it is older than five minutes. Revocation
  remains immediate; there is no session cache to invalidate.

### 7. Indexes are a scale measure

- Migration 019 adds composite indexes for factory-scoped run/work-item lists and partial
  indexes ordered by request time for pending queues. The measured SQL was already sub-ms, so
  these are for growth, not the 7s fix.

### 8. Loading states are honest

- `loading.tsx` renders the shell and skeleton rows; it never invents counts or cards.

## Risks / Trade-offs

- Registry metadata is stale for up to the TTL. A miss forces a sync, so a newly committed
  factory appears without a restart; explicit factory mutations can call sync directly.
- The in-process definition cache is per API instance; multi-instance deployments still get
  correctness from git and the DB, with only a cold cache per instance.
- The inbox returns at most `limit` rows per category (default 50) and exposes counts, so a
  large pending queue is paginated rather than silently truncated.

## Migration

- Apply 018 and 019 before deploying the new API. Existing rows are backfilled on the first
  sync; no data migration is needed because the registry is derived.
- `bun run ci`, the inbox integration suite and Playwright cover the new paths.
