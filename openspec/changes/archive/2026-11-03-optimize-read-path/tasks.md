# Tasks

## 1. Registry read model

- [x] 1.1 Add migration `018_factory_registry_read_model.sql` with version/resource columns.
- [x] 1.2 Make `syncFactoryRegistry` single-flight and TTL-bounded; force a sync on a miss at most once per TTL.
- [x] 1.3 Read `listFactories` and `resolveFactory` from the registry; fall back to the filesystem when the DB is unavailable.
- [x] 1.4 Add async `createVersionAsync` (`git diff-index`) and use it in the registry sync.
- [x] 1.5 Cache definitions by `(dir, commit)` and pass the registry version into `getFactory`.

## 2. Batch projections

- [x] 2.1 Add `GET /api/v1/inbox` with owner-scoped pending gates, permissions and failed runs plus counts.
- [x] 2.2 Add `view=board` to the work-items list: pending gate, run-link events, status counts, cursor.
- [x] 2.3 Add opaque keyset cursor encode/decode.
- [x] 2.4 Switch the inbox page to the batch endpoint.
- [x] 2.5 Switch the work-items board to the batch view and server-side status filtering.

## 3. Request memoization and session throttle

- [x] 3.1 Add React `cache()` wrappers for the factory list and detail.
- [x] 3.2 Use the wrappers in the layout, chat, factory page and help factory resolver.
- [x] 3.3 Throttle `sessions.last_seen_at` writes to five minutes.

## 4. Indexes and streaming

- [x] 4.1 Add migration `019_read_path_indexes.sql`.
- [x] 4.2 Add honest `loading.tsx` skeletons for `/inbox` and the work-items board.

## 5. Contract, tests and docs

- [x] 5.1 Update `apps/api/openapi.json` for `/inbox`, `view=board` and `cursor`.
- [x] 5.2 Add cursor unit tests and an inbox/board integration suite.
- [x] 5.3 Update `docs/PERFORMANCE.md`, `docs/STATUS.md`, `docs/HANDOVER.md`, README and API help.
- [x] 5.4 Run `bun run ci`, the inbox integration suite and Playwright.
