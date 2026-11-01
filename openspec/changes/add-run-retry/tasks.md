# Tasks

## 1. API (`apps/api`)

- [ ] 1.1 `POST /api/v1/runs/:id/retry` — load run input, reject `running|ok|kind!=chat` with `run_not_retryable`
- [ ] 1.2 Start a new `RunWorkflow` with a fresh id; set `retryOf` in the input
- [ ] 1.3 Dedupe double submits (`retryOf` within a short window) returning the existing child
- [ ] 1.4 `GET /api/v1/runs/:id` exposes `retryOf` and `retriedBy`
- [ ] 1.5 Tests: eligible, refused cases, dedupe, immutability of the original

## 2. Console (`apps/web`)

- [ ] 2.1 Same-origin proxy `POST /api/runs/[id]/retry`
- [ ] 2.2 `RetryRunButton` on eligible runs; disabled while pending; navigates to the new run
- [ ] 2.3 Lineage on both pages ("retried from" / "retried as")
- [ ] 2.4 Failure-panel copy references the retry control; stage runs explain work-item retry
- [ ] 2.5 Help entry for Runs mentions retry-as-new-run

## 3. Tests & wrap-up

- [ ] 3.1 Playwright: failed chat run → retry → new run page shows lineage; stage run shows no button
- [ ] 3.2 `bun run ci`, smoke, Playwright, UI audit green
- [ ] 3.3 STATUS updated; `openspec validate add-run-retry`
