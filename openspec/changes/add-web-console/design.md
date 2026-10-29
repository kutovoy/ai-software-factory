# Design

## Context

`apps/api` already exposes runs, SSE, permissions and the inference proxy. `@factory/core` can load,
validate, diff and version definitions. The web app must consume only the API — never the DB, never a
harness, never the filesystem.

## Goals / Non-Goals

**Goals:**
- Nav parity with the reference product, with `Definition` and `Gates` promoted to first-class pages.
- Live streaming that survives reload and reconnect (SSE replay).
- Every screen usable with keyboard only; no layout shift on stream.
- Playwright coverage of the core loop, run in CI.

**Non-Goals:**
- No gate decisions or approvals (Phase 3) — the UI *displays* gates and links to the inbox.
- No editing of definitions in the UI (read-only + diff; edits happen in git).
- No auth/users (Phase 6) — a single implicit local user.
- No benchmark execution UI (Phase 4) — page exists with an empty state.

## Decisions

1. **Next.js App Router, server components for reads, client components for streams.** Lists and factory
   pages render on the server by calling `apps/api`; chat and run detail are client components owning an
   `EventSource`.
2. **One event renderer.** A single `EventStream` component maps `FactoryEvent` → UI (message bubble,
   tool-call card, permission prompt, diff block, usage chip). Chat and run detail share it, which is what
   makes "chat is a run" visible in the product.
3. **Replay by `seq`, not by time.** SSE `id:` = `seq`; the client stores the last seen seq and sends
   `Last-Event-ID` on reconnect. Initial load renders persisted events from `GET /runs/:id/events?from=0`.
4. **Inbox is personal and actionable.** It lists only items needing *this* user: pending permission
   requests, failed runs, and (Phase 3) gate approvals. Acting on an item deep-links to the run with the
   relevant event focused.
5. **No client state library.** `useReducer` per screen; server data fetched in RSC. Keeps the bundle small
   and avoids hydration mismatches with streams.
6. **Tailwind only, small primitives.** `Card`, `Badge`, `Table`, `EmptyState`, `Spinner` — hand-written.
   No design-system dependency until the pages stabilize.
7. **Definition page is the star.** Shows the tree, the resolved gates table, the version (commit/tag/
   content hash), a diff against the previous version, and a "clone" action stub.
8. **Playwright against compose.** Tests run against `docker compose up` with the fake harness, so no model
   credentials are needed. Selectors use `data-testid` on semantic elements, not CSS classes.

## Risks / Trade-offs

- **SSE + Next.js dev server buffering.** Mitigation: proxy SSE through a route handler with
  `Cache-Control: no-cache` and `X-Accel-Buffering: no`; test in `next start`, not only dev.
- **Hydration mismatch from live events.** Mitigation: initial render is server-side list/detail without
  events; the client subscribes after mount.
- **Playwright flakiness on streams.** Mitigation: assert on terminal state and on specific event types
  with `expect.poll`, never on timing.
- **Nav parity sprawl.** Mitigation: stub pages share one `ComingSoon` component with the phase that will
  fill them, so nothing looks broken.
