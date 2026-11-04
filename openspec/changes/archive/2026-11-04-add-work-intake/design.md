# Design

## Context

`webhooks.ts` handles GitHub only. `webhook_deliveries` already dedupes by
`(provider, delivery_id)` and records status/reason/work item. Work-item `source` is a DB
check constrained to `forge|slack|cron|manual`.

## Decisions

### 1. One intake endpoint, provider adapters

`POST /factories/:factoryId/intake/:provider` accepts a raw body. Each provider adapter
normalizes title/prompt/external id/url/type. The generic adapter accepts
`{title,prompt,externalId,url}`; Sentry/PostHog/Slack/Linear/Jira read their native shapes.

### 2. Dedupe before creation

The external id is the delivery id. It is recorded in `webhook_deliveries` before signature
verification and work-item creation; a duplicate returns `202 {status:"ignored"}`. A rejected
signature marks the delivery `rejected` and creates nothing.

### 3. Signatures are provider-specific

- generic: `x-factory-signature: sha256=<hex>` with `FACTORY_INTAKE_SECRET`
- Sentry: `sentry-hook-signature` with `SENTRY_WEBHOOK_SECRET`
- PostHog: `x-posthog-signature` with `POSTHOG_WEBHOOK_SECRET`
- Slack: `x-slack-signature` `v0=<hex>` over `v0:<timestamp>:<raw>` with `SLACK_SIGNING_SECRET`
- Linear: `linear-signature` with `LINEAR_WEBHOOK_SECRET`
- Jira: `x-jira-signature` with `JIRA_WEBHOOK_SECRET`

No configured secret means local/dev intake is allowed; production sets the secret names in
the registry or environment.

### 4. Untrusted framing

Every prompt is wrapped by `frameUntrusted` so an agent treats provider text as data, never as
instructions. `sourceRef` carries `{kind, id, url, untrusted:true}`.

### 5. Source values

Add `sentry`, `posthog`, `linear`, `jira` and `api` to `WORK_ITEM_SOURCES` and the DB check.
`slack` already existed. Migration 020 replaces the unnamed check constraint.

## Risks / Trade-offs

- Provider payload shapes vary; adapters are intentionally narrow and can be extended.
- A duplicate delivery is acknowledged, not retried; the original work item id is returned by
  the delivery record if needed.
- Intake does not verify that the issue is still open; the factory's triage stage does that.

## Migration

`020_intake_sources.sql` drops and recreates `work_items_source_check`. No data rewrite.
