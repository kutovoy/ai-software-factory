# Design

## Context

`POST /factories/:factoryId/chat` creates a chat run through `createRun → startRun`; the
worker leases a runner and the adapter streams events. Intake creates work items through the
normal loop. The CLI package only had definition commands.

## Decisions

### 1. CLI is an API client, not a second execution path

`surfaceChat` posts to `/chat`, `surfaceIntake` posts to `/intake/:provider`, and
`surfaceWait` reads `/runs/:id`. Authentication uses the same session cookie as the console
(local admin defaults; `--cookie` for a pre-existing session). No CLI code leases a runner or
starts Temporal.

### 2. Surfaces share the contract

- Chat/console: `POST /chat`
- CLI: `factory run` → `POST /chat`
- CI: `factory intake --provider generic` or any HTTP client → `/intake/generic`
- Slack: `/intake/slack` with Slack signature verification
- API/webhooks: existing `/runs` and `/webhooks/:provider`

### 3. `--wait` polls the read model

`surfaceWait` polls `GET /runs/:id` until `ok|error|cancelled`, so a CI step can fail on a
non-ok run without implementing SSE.

## Risks / Trade-offs

- The CLI depends on the API being reachable and authenticated; it is not an offline tool.
- Polling is less live than SSE; the console remains the streaming surface.
- Slack/CI credentials are provider-side; the intake contract is unchanged.

## Migration

None.
