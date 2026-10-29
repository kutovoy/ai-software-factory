# Tasks

## 1. API factory projections (`apps/api`)

- [x] 1.1 `GET /factories` — list factories from `FACTORY_ROOT` (name, alias, repo count, version)
- [x] 1.2 `GET /factories/:name` — manifest + resolved gates (`resolveAllGates`) + `fullyAutonomous` + `benchmarkGateRequired`
- [x] 1.3 `GET /factories/:name/resources` — flattened resource tree (kind, name, path, summary)
- [x] 1.4 `GET /factories/:name/versions` — git log/tags for the factory directory (commit, tag, date, message)
- [x] 1.5 `GET /factories/:name/diff?from=&to=` — semantic diff via `@factory/core`
- [x] 1.6 Tests for each route incl. 404 `factory_not_found`

## 2. Web app shell (`apps/web`)

- [x] 2.1 Next.js App Router + Tailwind + `package.json`/`tsconfig`; `next start` works
- [x] 2.2 Layout: sidebar (nav parity), factory switcher, account footer, usage/status row
- [x] 2.3 Route groups: `/chat`, `/inbox`, `/runs`, `/runs/[id]`, `/factories/[name]/{dashboard,agents,automations,scorers,self-improvement,benchmarks,definition,gates,settings}`, `/mcps`, `/secrets`, `/users`
- [x] 2.4 Primitives: `Card`, `Badge`, `Table`, `EmptyState`, `Spinner`, `ComingSoon`
- [x] 2.5 API client with typed errors + `data-testid` conventions

## 3. Streaming (`apps/web`)

- [x] 3.1 `EventStream` renderer: message delta/completed, tool call started/completed, permission, file edited, usage, terminal
- [x] 3.2 `useRunStream(runId)` hook — `EventSource`, `Last-Event-ID` replay, gap detection, terminal close
- [x] 3.3 Auto-scroll only when pinned to bottom; no layout shift
- [x] 3.4 Permission prompt inline with allow/deny → `POST /runs/:id/permissions/:requestId`

## 4. Screens

- [x] 4.1 New Chat — prompt box, model/harness selector (from factory defaults), run header with cost/status
- [x] 4.2 Runs list — filters (factory, status), newest-first, empty state
- [x] 4.3 Run detail — pinned commit, harness/model, steps, artifacts, event stream, cancel button
- [x] 4.4 Inbox — pending permissions + failed runs, age, deep links, empty state
- [x] 4.5 Dashboard — run counts, terminal status split, cost total (from `/runs`), empty state
- [ ] 4.6 Definition — resource tree, resolved gates, version (commit/tag/hash), diff vs previous
- [ ] 4.7 Gates — per-stage resolved gate + source + merge policy + autonomy flag
- [ ] 4.8 Agents — role, harness/model, runner, tools, secret names
- [ ] 4.9 Automations / Scorers / Benchmarks / Self-improvement / Settings — read-only lists or phase stubs
- [ ] 4.10 MCPs and apps / Secrets / Users — phase stubs

## 5. Deployment & smoke

- [x] 5.1 `compose.yaml` gains `web` (build `apps/web`, depends on api, healthcheck `/`)
- [x] 5.2 `scripts/smoke.sh` asserts web `/` returns 200 and renders the nav
- [x] 5.3 `.env.example` gains `API_BASE_URL` / `NEXT_PUBLIC_API_BASE_URL`

## 6. Playwright

- [x] 6.1 `apps/web/e2e/` + `playwright.config.ts` (baseURL from env, retries 1, trace on failure)
- [x] 6.2 `chat.spec.ts` — prompt → tool call visible → approve permission → terminal state
- [x] 6.3 `runs.spec.ts` — list renders, detail shows pinned commit, replay after reload
- [x] 6.4 `nav.spec.ts` — every nav item renders, stubs name their phase, no console errors
- [x] 6.5 `inbox.spec.ts` — pending permission appears and deep-links to the run
- [ ] 6.6 `definition.spec.ts` — gates table + version + diff render
- [ ] 6.7 CI: `bunx playwright install --with-deps chromium` + `playwright test` against compose

## 7. Wrap-up

- [x] 7.1 `apps/web/README.md` — dev workflow, testids, SSE notes
- [ ] 7.2 `docs/STATUS.md` updated (2b complete, Phase 3 next)
- [ ] 7.3 ADR-012 (web consumes API only; one event renderer)
- [ ] 7.4 `openspec validate add-web-console` passes
