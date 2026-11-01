# Tasks

## 1. API (`apps/api`)

- [x] 1.1 `POST /api/v1/work-items/:id/retry` — body `{actor, reason?}`; refuse `active|done` with
      `work_item_not_retryable`
- [x] 1.2 Transition to `active`, clear `cancel_requested_at/actor/reason`, record `work_item.retried`
      (previous status, actor, reason)
- [x] 1.3 Dispatch the current stage under a new attempt workflow id (`factory-<item>-a<n>`); dedupe double
      submits within 60s
- [x] 1.4 Expose `attempt` / `retriedAt` on the work-item projection
- [x] 1.5 Tests: escalated retry, refused statuses, idempotency, cancelled item clears flags

## 2. Console (`apps/web`)

- [x] 2.1 Run page: render Cancel only for live runs; terminal runs show status text
- [x] 2.2 Stage runs: replace per-run retry with "Retry the work item" link (derive work item id)
- [x] 2.3 Work-item page: "Retry work item" for escalated/failed/blocked, actor + reason dialog, disabled
      while pending, reload on success
- [x] 2.4 Chat runs keep "Retry as new run"

## 3. Tests & wrap-up

- [x] 3.1 Playwright: terminal run has no cancel; escalated item retry → new attempt, item active
- [x] 3.2 `bun run ci`, smoke, Playwright, UI audit green
- [x] 3.3 STATUS updated; `openspec validate fix-run-actions`
