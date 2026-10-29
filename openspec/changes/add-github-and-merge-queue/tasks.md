# Tasks

## 1. GitHub forge (`packages/forge`)

- [ ] 1.1 `github.ts` — REST client (`fetch` injected), auth by secret reference (`pat`), ETag cache, backoff
- [ ] 1.2 Implement all `CodeForge` methods incl. `getChecks` + `merge` (squash, required checks)
- [ ] 1.3 `protected_branch` enforcement; error mapping (`auth_failed`, `rate_limited`, `not_found`)
- [ ] 1.4 Dry-run mode (`GITHUB_DRY_RUN=1`) — synthetic results + intended-action events
- [ ] 1.5 Contract suite runs against `FakeForge` + `GitHubForge` with recorded `fetch` fixtures; `RUN_GITHUB=1` opt-in

## 2. Merge queue (`packages/merge`)

- [ ] 2.1 `MergeQueueWorkflow` — per-factory serialized batches (`batchSize` configurable, default 2)
- [ ] 2.2 Batch gating: merged stack + required checks; `checks_timeout`
- [ ] 2.3 Bisect on red → merge clean subset, offender `needs_human` with evidence
- [ ] 2.4 Revert on red (single revert commit) + manual revert; `merge.reverted` event
- [ ] 2.5 Tests with fake forge: green batch, bisect, timeout, revert

## 3. Webhooks & automations (`apps/api`)

- [ ] 3.1 `POST /webhooks/:provider` — HMAC verify (`X-Hub-Signature-256`), `invalid_signature`, size cap
- [ ] 3.2 Dedupe by delivery id; `skip_bots` default `all`; untrusted-payload framing
- [ ] 3.3 Filters (repo/labels/branch/event) → work item creation with `sourceRef`
- [ ] 3.4 Cron automations via Temporal schedules; pause on disable; idempotent fires
- [ ] 3.5 Tests: signature accept/reject, dedupe, bot skip, non-matching event, schedule pause

## 4. Persistence (`packages/core`)

- [ ] 4.1 `008_merge_and_webhooks.sql`: `merge_batches`, `merge_batch_items`, `webhook_deliveries`, `automation_schedules`
- [ ] 4.2 Repository functions + idempotent upserts

## 5. API & UI

- [ ] 5.1 `GET /factories/:name/merge-queue`, `POST /merge-queue/revert`
- [ ] 5.2 `GET /factories/:name/integrations`, `POST /integrations/github` (token secret ref, repos, dry-run)
- [ ] 5.3 UI: Integrations/Settings page (connection status, repos, webhook URL + secret ref, dry-run toggle)
- [ ] 5.4 UI: Merge queue page (batch, PRs, checks, bisect result, revert)
- [ ] 5.5 UI: Automations page shows webhook/cron status + last fire

## 6. Tests & wrap-up

- [ ] 6.1 Integration: webhook → work item → loop → PR → merge queue → merged
- [ ] 6.2 E2E: integrations page + merge queue page render with fake data
- [ ] 6.3 Smoke: signed webhook delivery creates a work item; unsigned rejected
- [ ] 6.4 STATUS, ADR-022 (queue owns merges), ADR-023 (webhooks untrusted by default)
- [ ] 6.5 `openspec validate add-github-and-merge-queue`
