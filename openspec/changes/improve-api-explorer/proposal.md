# Proposal

## Why

LiteLLM's Swagger UI feels better because of presentation, not a different engine: full-width `BaseLayout`, a
filter box, alphabetically sorted tags/operations, request durations, extensions, tag descriptions, and a
Servers dropdown that tells the truth. Our explorer is the same Swagger UI squeezed into `max-w-4xl` with none of
those enabled, and its Servers dropdown still shows `http://localhost:8080` although requests are rewritten.

## What Changes

- **Full-width explorer** on `/help/api` (prose stays readable; the explorer uses the viewport), matching the
  LiteLLM layout.
- **Swagger UI config parity:** `filter: true`, `tagsSorter: 'alpha'`, `operationsSorter: 'alpha'`,
  `displayRequestDuration: true`, `showExtensions: true`, `showCommonExtensions: true`, `docExpansion: 'list'`,
  `defaultModelsExpandDepth: -1`, `deepLinking: true`, `tryItOutEnabled: true`
  (<https://swagger.io/docs/open-source-tools/swagger-ui/usage/configuration/>).
- **Tag metadata:** a top-level `tags` array with a description per resource, so groups render with context
  (<https://swagger.io/docs/specification/v3_0/grouping-operations-with-tags/>,
  <https://www.speakeasy.com/openapi/tags>).
- **Console-targeted spec:** `/api/openapi.json?servers=console` rewrites `servers` to the console origin, so the
  Servers dropdown is honest and try-it-out needs no interceptor. The canonical spec keeps the direct API server
  for Postman/Swagger UI consumers.
- **Toolbar:** a compact header above the explorer with the API version, the console-proxied base URL and the
  no-auth warning — the part of LiteLLM's Standalone topbar that matters here.

## Capabilities

### Modified Capabilities
- `web-console`: API explorer presentation parity, tag metadata, truthful server selector.

## Impact

- Spec metadata + one query parameter on the existing spec proxy; no backend change, no new dependency.
