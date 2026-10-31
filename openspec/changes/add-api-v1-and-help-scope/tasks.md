# Tasks

## 1. API v1 (`apps/api`, `apps/web`)

- [ ] 1.1 Register every route under `/api/v1` via one prefix constant; keep `GET /health` unversioned and add
      `GET /api/v1/health`
- [ ] 1.2 Update all server-side fetches (`apps/web/src/lib/api.ts` and pages), same-origin route handlers and
      `API_BASE_URL` usage
- [ ] 1.3 Update `scripts/smoke.sh`, `scripts/smoke-permissions.sh`, docs/HANDOVER repro commands and any
      `curl` examples
- [ ] 1.4 Update API tests and integration tests to the new paths; add a test asserting unversioned resource
      paths return 404
- [ ] 1.5 Webhook URL rendering and `WEBHOOK_PUBLIC_URL` examples use `/api/v1/webhooks/:provider`

## 2. OpenAPI (`apps/api`)

- [ ] 2.1 `apps/api/openapi.json` (OpenAPI 3.1): every route with method, path, summary, params, response codes
- [ ] 2.2 Serve it at `GET /api/v1/openapi.json`
- [ ] 2.3 Contract test: registered route table ↔ spec, failing on either direction with method + path
- [ ] 2.4 Test: spec is valid JSON and every path starts with `/api/v1` (health documented as unversioned)

## 3. Help: API section

- [ ] 3.1 Sidebar `API` entry above `Help` (`nav-api`), active on `/help/api`
- [ ] 3.2 `/help/api` renders the reference from the spec (grouped by resource, method badge, path, purpose,
      params) with a link to the raw document and a note that Swagger UI/Postman can consume it
- [ ] 3.3 Help entry states the versioning rule and that breaking changes bump the prefix
- [ ] 3.4 Registry entry for `API` in `help.ts`; `help.test.ts` nav parity still passes

## 4. Help: supported projects

- [ ] 4.1 `help/factories/supported-projects` (under factory how-tos): unit of work is a repository diff verified
      by checks; examples — application code, tests, docs, configuration, Terraform modules/plans, migrations
- [ ] 4.2 Explicit out-of-scope list: applying infrastructure, physical actions, binary/artefact outputs with no
      check, anything requiring credentials the runner does not hold
- [ ] 4.3 State the mechanism: agents produce a branch + PR, checks gate it, the merge queue lands it; IaC changes
      are proposed, never applied
- [ ] 4.4 Link it from the quick start and the factory how-tos index

## 5. Sidebar footer

- [ ] 5.1 Sidebar becomes `sticky top-0 h-screen` (or equivalent bounded flex) with the nav list as the only
      scroll area (`min-h-0 overflow-y-auto`)
- [ ] 5.2 Usage/account/Help footer stays visible on long pages; no layout shift between short and long pages
- [ ] 5.3 Playwright: on `/help/quick-start` the footer is visible without scrolling

## 6. AGENTS.md

- [ ] 6.1 Rule: HTTP API lives under `/api/v1`; `apps/api/openapi.json` is the source of truth and must be updated
      in the same change; the contract test enforces parity; `/health` stays unversioned
- [ ] 6.2 Rule: prefer 2–3 subagents for large workstreams (split by layer, run sequentially when files overlap)
      to conserve main-agent context

## 7. Tests & wrap-up

- [ ] 7.1 Playwright: API nav → reference lists endpoints; sidebar footer visible on help; `?` on `/help/api`
- [ ] 7.2 UI audit still clean (35+ routes, no overflow, no console errors)
- [ ] 7.3 `bun run ci`, smoke, Playwright green
- [ ] 7.4 STATUS + ADR-030 (path-versioned API, spec parity) + `openspec validate`
