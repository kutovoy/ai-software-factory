# Design

## Context

`CodeForge` already abstracts checkout/branch/commit/PR/comment/checks/merge, with a fake backend and a shared
contract suite. The loop ships stages and gates. What is missing is a real transport and a safe way to land
multiple PRs.

## Goals / Non-Goals

**Goals:**
- A GitHub backend that passes the same contract tests as the fake one.
- A merge queue that serializes merges, validates the merged stack, and never lets an agent push to main.
- Webhook ingestion that is safe by default (signature, dedupe, bot skip, untrusted payload framing).
- CI remains credential-free.

**Non-Goals:**
- No GitLab/Azure DevOps backends (webhook + token clone is the escape hatch).
- No GitHub App installation flow in v1 (PAT by secret reference first; App auth behind the same interface).
- No multi-tenant credential isolation (Phase 6).

## Decisions

1. **Token by reference.** The GitHub client resolves a secret name at run time (`GITHUB_TOKEN`); values never
   appear in definitions, logs or events. Auth mode is an interface detail (`pat|app`) so an App can be added
   without touching callers.
2. **Contract tests are shared.** The same suite runs against `FakeForge` and a `GitHubForge` wired to an
   injected `fetch` stub that replays recorded responses. Real network calls are opt-in (`RUN_GITHUB=1`).
3. **Dry-run mode.** `GITHUB_DRY_RUN=1` makes every mutating call a no-op that returns a synthetic result and
   logs the intended action — useful for demos and for validating wiring without touching a repo.
4. **Merge queue is per factory, serialized.** Agents open PRs; the queue owns merges. It batches ready PRs,
   builds the merged stack, runs required checks, and merges the batch only if green. On red it bisects to the
   offending PR, merges the clean subset, and marks the offender `needs_human`.
5. **Revert on red after merge.** If the default branch goes red after a batch merge, the queue reverts the
   batch as a single revert commit and records evidence.
6. **Webhooks are untrusted input.** Verify `X-Hub-Signature-256` against the configured secret; dedupe by
   `X-GitHub-Delivery`; drop bot senders by default (`skip_bots: all`); treat payload text as data, never as
   instructions; cap payload size.
7. **Cron via Temporal schedules.** Definition automations with `schedule` become Temporal schedules that
   start a work item; pausing an automation deletes/pauses the schedule.
8. **Idempotency everywhere.** Webhook delivery ids, merge batch ids and schedule runs are idempotent keys.

## Risks / Trade-offs

- **Merge queue correctness is hard.** Mitigation: serialize per factory, gate the merged stack, bisect, revert;
  start with a small batch size (1–3) and make it configurable.
- **Webhook spoofing.** Mitigation: HMAC verification mandatory outside dry-run; reject unsigned requests.
- **Token scope.** Mitigation: document the minimum scopes (repo, pull_request, checks); prefer a fine-grained
  PAT or App.
- **Rate limits.** Mitigation: backoff + ETag caching in the client; surface `rate_limit_remaining`.
