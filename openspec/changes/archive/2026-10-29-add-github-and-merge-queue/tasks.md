# Tasks

## 1. GitHub forge (`packages/forge`)

- [x] 1.1 `github.ts` — REST client (`fetch` injected), auth by secret reference (`pat`), ETag cache, backoff
- [x] 1.2 Implement all `CodeForge` methods incl. `getChecks` + `merge` (squash, required checks)
- [x] 1.3 `protected_branch` enforcement; error mapping (`auth_failed`, `rate_limited`, `not_found`)
- [x] 1.4 Dry-run mode (`GITHUB_DRY_RUN=1`) — synthetic results + intended-action events
- [x] 1.5 Contract suite runs against `FakeForge` + `GitHubForge` with recorded `fetch` fixtures; `RUN_GITHUB=1` opt-in

## 2. Merge queue (`packages/merge`)

- [x] 2.1 `MergeQueueWorkflow` — per-factory serialized batches (`batchSize` configurable, default 2)
- [x] 2.2 Batch gating: merged stack + required checks; `checks_timeout`
- [x] 2.3 Bisect on red → merge clean subset, offender `needs_human` with evidence
- [x] 2.4 Revert on red (single revert commit) + manual revert; `merge.reverted` event
- [x] 2.5 Tests with fake forge: green batch, bisect, timeout, revert

## 3. Webhooks & automations (`apps/api`)

- [x] 3.1 `POST /webhooks/:provider` — HMAC verify (`X-Hub-Signature-256`), `invalid_signature`, size cap
- [x] 3.2 Dedupe by delivery id; `skip_bots` default `all`; untrusted-payload framing
- [x] 3.3 Filters (repo/labels/branch/event) → work item creation with `sourceRef`
- [x] 3.4 Cron automations via Temporal schedules; pause on disable; idempotent fires
- [x] 3.5 Tests: signature accept/reject, dedupe, bot skip, non-matching event, schedule pause

## 4. Persistence (`packages/core`)

- [x] 4.1 `008_merge_and_webhooks.sql`: `merge_batches`, `merge_batch_items`, `webhook_deliveries`, `automation_schedules`
- [x] 4.2 Repository functions + idempotent upserts

## 5. API & UI

- [x] 5.1 `GET /factories/:name/merge-queue`, `POST /merge-queue/revert`
- [x] 5.2 `GET /factories/:name/integrations`, `POST /integrations/github` (token secret ref, repos, dry-run)
- [x] 5.3 UI: Integrations/Settings page (connection status, repos, webhook URL + secret ref, dry-run toggle)
- [x] 5.4 UI: Merge queue page (batch, PRs, checks, bisect result, revert)
- [x] 5.5 UI: Automations page shows webhook/cron status + last fire

## 6. Tests & wrap-up

- [x] 6.1 Integration: webhook → work item → loop → PR → merge queue → merged
- [x] 6.2 E2E: integrations page + merge queue page render with fake data
- [x] 6.3 Smoke: signed webhook delivery creates a work item; unsigned rejected
- [x] 6.4 STATUS, ADR-022 (queue owns merges), ADR-023 (webhooks untrusted by default)
- [x] 6.5 `openspec validate add-github-and-merge-queue`
