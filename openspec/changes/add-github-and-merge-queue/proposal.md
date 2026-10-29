# Proposal

## Why

Everything so far runs against a fake forge, which is right for CI but useless for daily work. Phase 3b makes
the factory operate on real repositories: a GitHub backend, a merge queue that never lets agents push to main,
and webhook-driven automations so work enters from labels, PRs and comments.

## What Changes

- Add a `github` backend to `packages/forge`: REST client with token/app auth by secret reference, contract
  tests against the fake backend using an injected `fetch` (no network in CI), and a dry-run mode.
- Add `packages/merge`: a Bors-style merge queue — batch PRs, gate the merged stack, bisect on red, revert on
  red, never push to the default branch from an agent.
- Add webhook automations: `POST /webhooks/:provider` with HMAC verification, delivery-id dedupe, label/branch
  filters, `skip_bots`, and work-item creation from GitHub issues/PRs/comments.
- Add cron automations via Temporal schedules.
- Add UI: Integrations/Settings page (GitHub connection, repos, webhook URL + secret reference, dry-run) and a
  Merge queue page.

## Capabilities

### New Capabilities
- `code-forge`: pluggable repository backends with a GitHub implementation and a shared contract.
- `merge-queue`: serialized, gated merging with bisect and revert.
- `automations`: webhook and scheduled triggers that create work items.

### Modified Capabilities
<!-- factory-loop unchanged: it already consumes CodeForge -->

## Impact

- New package `packages/merge`; new GitHub client; new webhook routes; new UI pages.
- Requires a GitHub token/app secret for real use; CI stays credential-free.
- Closes the gap between the demo loop and a factory you can point at a real repo.
