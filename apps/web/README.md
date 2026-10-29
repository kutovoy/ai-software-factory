# apps/web — the console

Next.js App Router + Tailwind. This is the **harness front-end**: the chat *is* a run, and the
same `FactoryEvent` renderer draws chat and factory runs.

## Hard rules

- The console **never** reads Postgres, the filesystem, a harness or `apps/api`'s internals.
  Everything comes from `apps/api` over HTTP (ADR-012).
- Server components fetch the API directly (`API_BASE_URL`). Client components talk to
  same-origin route handlers under `/api/*`, which proxy the API — no CORS, no cross-origin
  `EventSource`, and SSE stays un-buffered.
- No client state library. `useReducer`/`useState` per screen; server data is fetched in RSC.
- No component library. `Card`, `Badge`, `Table`, `EmptyState`, `Spinner`, `ComingSoon` only.

## Layout

```
src/app
  layout.tsx                       shell: sidebar (nav parity) + factory switcher + account row
  chat/page.tsx                    New Chat (RSC shell → client composer + stream)
  inbox/page.tsx                   pending permissions + failed runs, deep links
  runs/page.tsx                    list (filters, newest-first)
  runs/[id]/page.tsx               detail: pinned commit, harness/model, steps, artifacts, stream
  factories/[name]/dashboard       run counts, status split, spend
  factories/[name]/definition      resource tree by kind, resolved gates, version + semantic diff (from/to)
  factories/[name]/gates           per-stage gate, resolution source, merge policy, autonomy warning
  factories/[name]/agents          role, harness/model, runner, tools allow/deny, secret names, spawnableBy
  factories/[name]/automations     triggers, agent, gate overrides (dispatch is Phase 3)
  factories/[name]/scorers         labels, passingScore, samplingRate, judge model (scoring is Phase 4)
  factories/[name]/benchmarks      suites, configurations, pinned tasks (replay is Phase 4)
  factories/[name]/self-improvement threshold, reviewer type, benchmark win (loop is Phase 5)
  factories/[name]/settings        manifest, repositories, agent defaults, secret/integration/MCP names
  mcps|secrets|users               phase stubs (ComingSoon) — MCPs Phase 3, Secrets/Users Phase 6
  api/chat                         POST proxy → /chat
  api/runs/[id]/events             SSE proxy (forwards Last-Event-ID / lastEventId)
  api/runs/[id]/permissions/[requestId]
  api/runs/[id]/cancel
src/components
  nav/Sidebar.tsx                  client: active state + factory switcher
  factory/ReadOnlyNotice.tsx       "definitions are edited in git" banner
  factory/FactoryStubPage.tsx      shared shell for pages that ship later
  stream/EventStream.tsx           the ONE renderer (chat + run detail)
  stream/useRunStream.ts           EventSource + replay + gap detection + terminal close
  stream/RunLive.tsx               run detail's live half
src/lib
  api.ts                           typed client (`ApiClientError`), `safeGet`/`getOrError` for degraded shell
  definition.ts                    typed read-only views over resource `doc`s (agents/automations/scorers/benchmarks)
  events.ts                        FactoryEvent → StreamBlock reducer (pure)
  nav.ts                           nav map + `factoryHref`
```

## Dev

```bash
# API must be running (compose or `bun run api`)
API_BASE_URL=http://localhost:8080 bun run --cwd apps/web dev     # http://localhost:3000

bun run typecheck                                                # from the repo root
bun run --cwd apps/web build && bun run --cwd apps/web start     # production mode
```

Full stack:

```bash
docker compose up -d --build     # api, worker, postgres, temporal, web
bash scripts/smoke.sh            # includes the web `/` + nav check
```

## SSE notes (why this shape)

- The API's `id:` is the event `seq`. The hook reconnects with `?lastEventId=<last seq>`; the
  proxy forwards it as `Last-Event-ID`. Replay is strictly `seq > cursor`, so no duplicates.
- A jump in `seq` is treated as a gap: the hook closes and reconnects from the last contiguous
  seq to backfill, then continues tailing.
- `run.completed` closes the `EventSource` and stops reconnecting (terminal runs are replayed
  once and then the stream ends).
- Auto-scroll happens only while the reader is pinned to the bottom; the container reserves its
  scrollbar gutter (`scroll-stable`) so growing content cannot shift the layout.

## Test ids (Playwright contract)

Stable `data-testid` hooks — never select by CSS class:

| area | ids |
|---|---|
| shell | `nav-sidebar`, `factory-switcher`, `nav-chat`, `nav-inbox`, `nav-runs`, `nav-mcps`, `nav-secrets`, `nav-users`, `nav-dashboard`, `nav-agents`, `nav-automations`, `nav-scorers`, `nav-self-improvement`, `nav-benchmarks`, `nav-definition`, `nav-gates`, `nav-settings`, `nav-usage`, `nav-account`, `nav-factory-name` |
| chat | `chat-composer`, `chat-prompt`, `chat-harness`, `chat-model`, `chat-submit`, `chat-error`, `run-header`, `run-link`, `run-status`, `run-harness`, `run-model`, `run-cost` |
| stream | `event-stream`, `event-message`, `tool-call` (+ `data-tool-name`, `data-ok`), `tool-call-args`, `tool-call-result`, `permission-prompt` (+ `data-request-id`, `data-status`, `data-focused`), `permission-allow`, `permission-deny`, `permission-status`, `permission-outcome`, `file-edited`, `file-diff`, `usage-chip`, `artifact-event`, `run-terminal` (+ `data-status`), `run-last-seq` |
| runs | `runs-filters`, `runs-filter-factory`, `runs-filter-status`, `runs-table`, `run-row`, `run-row-link`, `run-row-status`, `run-row-commit`, `runs-empty`, `pinned-commit`, `run-steps`, `run-artifacts`, `run-cancel` |
| inbox | `inbox-item` (+ `data-kind`, `data-run-id`), `inbox-item-link`, `inbox-empty` |
| factory | `dashboard-counts`, `dashboard-status`, `dashboard-cost`, `dashboard-empty`, `coming-soon`, `coming-soon-phase` |

## E2E

```bash
docker compose up -d --build
cd apps/web
bunx playwright install chromium        # once
bunx playwright test                    # E2E_BASE_URL defaults to http://localhost:3000
```

Specs: `chat.spec.ts` (prompt → tool call → approve → terminal, no provider key in the page),
`runs.spec.ts` (list, pinned commit, reload mid-stream replay without duplicates),
`nav.spec.ts` (every nav item, stubs name their phase, no console errors),
`inbox.spec.ts` (pending permission → deep link → act).
