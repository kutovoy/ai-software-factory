# Tasks

## 1. API (`apps/api`)

- [x] 1.1 `POST /api/v1/factories/:factoryId/runs/:id/retry` — load run input, reject `running|ok|kind!=chat` with `run_not_retryable`
- [x] 1.2 Start a new `RunWorkflow` with a fresh id; set `retryOf` in the input
- [x] 1.3 Dedupe double submits (`retryOf` within a short window) returning the existing child
- [x] 1.4 `GET /api/v1/factories/:factoryId/runs/:id` exposes `retryOf` and `retriedBy`
- [x] 1.5 Tests: eligible, refused cases, dedupe, immutability of the original

## 2. Console (`apps/web`)

- [x] 2.1 Same-origin catch-all proxy `/api/v1/[...path]` forwards the nested retry request
- [x] 2.2 `RetryRunButton` on eligible runs; disabled while pending; navigates to the new run
- [x] 2.3 Lineage on both pages ("retried from" / "retried as")
- [x] 2.4 Failure-panel copy references the retry control; stage runs explain work-item retry
- [x] 2.5 Help entry for Runs mentions retry-as-new-run

## 3. Tests & wrap-up

- [x] 3.1 Playwright: cancelled chat run → retry → new run page shows lineage; stage run shows no button
- [x] 3.2 `bun run ci`, smoke, Playwright, UI audit green
- [x] 3.3 STATUS updated; `openspec validate add-run-retry`
