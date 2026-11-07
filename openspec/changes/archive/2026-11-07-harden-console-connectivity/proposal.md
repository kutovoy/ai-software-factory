# Proposal

## Why

During a backend or web restart the console could go blank and, in some cases, repeatedly
navigate to `/login`. The root layout treated a failed `/auth/me` as “signed out”, so an API
outage redirected every page to sign-in; auto-refresh then kept re-rendering and produced the
browser’s navigation-throttling warning and failed RSC payload fetches. Pages that fetch a
detail projection with `apiGet` had no route error boundary, so a 5xx/network failure replaced
the page with Next’s default error screen.

## What Changes

- The auth gate distinguishes “API answered 401/403 or no user” from “API unreachable/5xx”.
  Only the former redirects to `/login`; the latter renders the shell in degraded mode.
- A console-wide connection banner pings the same-origin `/api/v1/health` proxy, retries
  automatically every 5s, offers a manual retry, and refreshes server components once the
  backend is back.
- Auto-refresh pauses while the connection is down, so it cannot hammer the router.
- Route-level and root-layout error boundaries show a connection message with retry/reload
  instead of a white page.
- Server-side API reads have a bounded timeout so a dead socket becomes a degraded read rather
  than an indefinitely hanging render.
- The sidebar says “Session unavailable” instead of “Not signed in” when the API could not
  resolve the session.

## Capabilities

### Modified Capabilities

- `console-auth`: session resolution during API outages.
- `web-console`: connection-failure recovery, retry and error boundaries.

## Impact

- `apps/web` only; no API schema, migration or runner change.
- E2E coverage for the banner and retry path; unit coverage for the auth-gate decision.
