# Proposal

## Why

Three gaps: (1) the sidebar footer (usage/account) scrolls out of view on long pages such as Help because the
sidebar grows with content instead of staying pinned; (2) the HTTP API is unversioned and undocumented inside the
product; (3) the help centre never answers the most common question — *what can this factory actually build?*

## What Changes

- **Sidebar layout fix:** the sidebar becomes a pinned, independently scrolling column; the usage/account footer
  stays visible on every page, including long help pages.
- **Versioned API:** every backend endpoint moves under `/api/v1` (health stays unversioned for probes), with
  breaking changes bumping the version (<https://www.speakeasy.com/api-design/versioning>). All callers — the
  console's server fetches, same-origin route handlers, smoke scripts, tests and docs — are updated.
- **OpenAPI as source of truth:** `apps/api/openapi.json`, served at `GET /api/v1/openapi.json`, and a contract
  test that fails when a registered route is missing from the spec or the spec documents a route that does not
  exist.
- **API section in the product:** a sidebar `API` entry above `Help`, and `/help/api` rendering the endpoint
  reference from the spec (method, path, purpose, params) plus a link to the raw spec for Swagger UI/Postman.
- **Supported projects:** a help how-to stating what the factory can build — anything expressible as a repository
  diff verified by checks (code, tests, docs, configuration, Terraform plans/modules) — and what it cannot:
  applying infrastructure, non-repository artefacts, or anything without a check.

## Capabilities

### New Capabilities
- `http-api`: versioned, documented HTTP surface with spec/route parity.

### Modified Capabilities
- `web-console`: pinned sidebar footer, API reference page, supported-projects guidance.

## Impact

- Mechanical but wide: every API path, its callers and tests.
- No schema change; no new runtime dependency (the API reference renders from the spec).
