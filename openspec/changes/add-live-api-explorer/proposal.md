# Proposal

## Why

`/help/api` renders a static reference: you can read the endpoints but not call them. Swagger UI's "Try it out"
is the expected experience, and it needs two things the current page lacks — a client-side Swagger UI bundle and a
same-origin path so browser requests do not hit CORS.

## What Changes

- **Live explorer:** `swagger-ui-react` (5.34.x, supports React <20) loaded in a Client Component with
  `dynamic(..., { ssr: false })`, pointed at the existing `/api/openapi.json` document, with "Try it out"
  enabled and deep links on.
- **Same-origin proxy:** `apps/web/src/app/api/v1/[...path]/route.ts` forwards every method to
  `API_BASE_URL/api/v1/<path>`, so explorer requests stay on the console origin. This is the documented way to
  avoid CORS with Swagger UI (<https://swagger.io/docs/open-source-tools/swagger-ui/usage/cors/>).
- **Page layout:** the live explorer is primary; the existing static reference stays below it as a readable
  fallback when JavaScript or the API is unavailable. A banner states that actions execute against this stack and
  that the local API has no authentication.
- **Help stays current:** the `api` entry is updated in the same change (AGENTS.md rule).

## Capabilities

### Modified Capabilities
- `web-console`: the API help entry becomes executable, same-origin, with a fallback reference.

## Impact

- One new dependency in `apps/web`; one catch-all proxy route; no backend change.
- Try-it-out can invoke destructive endpoints on the local stack — surfaced in the UI, not hidden.
