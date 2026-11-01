# Tasks

## 1. Auto-refresh (`apps/web`)

- [x] 1.1 `AutoRefresh` client control in the shared header, right of the help control: Off / 15s / 30s / 60s,
      default 15s, persisted in `localStorage`
- [x] 1.2 Refresh via `router.refresh()`; pause when `document.hidden`; show "updated <relative time>"
- [x] 1.3 Hide on `/help` and `/help/*`; no timer there
- [x] 1.4 Playwright: control present on Dashboard/Runs/Work items, absent on `/help` and `/help/api`

## 2. Factory dashboard (`/factories/:name/dashboard`)

- [x] 2.1 State card: autonomy (enabled/paused, override), canary (active/last), last activity
- [x] 2.2 Work items: counts by status + recent items (title, stage, status, updated) linking to detail
- [x] 2.3 Runs: recent runs (status, harness/model, cost, started) linking to run detail
- [x] 2.4 Deliverables: PR links from items, merged count, latest patch/artifact link; explainer of where
      results live (PR + run artifacts)
- [x] 2.5 Keep metric cards and cost-by-stage; honest empty states
- [x] 2.6 Playwright: hello-nextjs dashboard shows the completed item, its PR and the patch/artifact entry

## 3. Factory selection (`apps/web`)

- [x] 3.1 Persist selected factory in a cookie (`factory`); layout passes it to the sidebar
- [x] 3.2 Sidebar: path wins on `/factories/:name/*`; otherwise use the persisted factory; switcher updates the
      cookie and navigates
- [x] 3.3 Playwright: select a factory, click Runs, sidebar keeps it

## 4. Work-items board

- [x] 4.1 Status chips: all / active / escalated / done / failed / cancelled; cancelled off by default
- [x] 4.2 Cards show created + last-updated (relative with absolute in `title`)
- [x] 4.3 Keep factory filter; empty state when filters exclude everything
- [x] 4.4 Playwright: cancelled hidden by default, toggling shows them, timestamps visible

## 5. Wrap-up

- [x] 5.1 `bun run ci`, smoke, Playwright, UI audit green
- [x] 5.2 Update Runs/Work-items/Dashboard help entries; STATUS
- [x] 5.3 `openspec validate improve-console-ops`
