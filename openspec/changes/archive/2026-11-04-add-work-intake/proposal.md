# Proposal

## Why

Work enters the factory only from GitHub webhooks, cron and manual creation. Roadmap item 8
asks for intake from Sentry, PostHog, Slack, Linear, Jira and a generic API, with dedupe and
verification before a ticket is created.

## What Changes

- Add nested `POST /api/v1/factories/:factoryId/intake/:provider` for `generic`, `sentry`,
  `posthog`, `slack`, `linear` and `jira`.
- Verify provider HMAC signatures when a secret is configured; local/dev may run without one.
- Dedupe by an external delivery id in the existing `webhook_deliveries` table.
- Frame all payload text as untrusted data before it reaches an agent.
- Normalize provider payloads into a normal work item (title, prompt, type, sourceRef).
- Add `GET /api/v1/factories/:factoryId/intake` for recent intake deliveries.
- Add intake source values to the work-item schema and DB check.

## Capabilities

### New Capabilities
- None.

### Modified Capabilities
- `automations`: external intake providers and delivery dedupe.
- `factory-loop`: work items can enter from additional sources.

## Impact

- `apps/api/src/intake.ts`, `apps/api/src/app.ts`, `apps/api/openapi.json`
- `packages/core/src/work-items/types.ts`, migration `020_intake_sources.sql`
- Tests: signature verification and intake normalization.

## Non-goals

- No polling of provider APIs; intake is webhook/API push only.
- No automatic provider-side replies or status sync.
- No new queue: accepted intake creates a normal work item and starts the normal loop.
