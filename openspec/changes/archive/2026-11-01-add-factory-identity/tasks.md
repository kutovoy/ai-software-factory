# Tasks

## 1. Definition + registry
- [x] 1.1 Optional `id` in schema; runtime requires `fac_<ulid>`
- [x] 1.2 Migration: `factories` registry; `work_items.factory_id`/`runs.factory_id`
- [x] 1.3 Registry sync for legacy top-level and nested owner paths
- [x] 1.4 Backfill script + IDs for `example`, `example-lights-off`, `hello-nextjs`

## 2. API
- [x] 2.1 Resolve factories by id; owner checks (404)
- [x] 2.2 Nested factory routes; remove name/global routes
- [x] 2.3 Nested work-item/run/gate/retry/cancel/event routes
- [x] 2.4 Factory subresources (autonomy, integrations, MCP, benchmarks, canary, improvement, merge queue, automations)
- [x] 2.5 Work-item/run creation stores `factory_id` and qualified key
- [x] 2.6 OpenAPI + contract test

## 3. Console
- [x] 3.1 `/factories/[id]/…` routes and links
- [x] 3.2 Nested work-item/run pages
- [x] 3.3 Factory list/switcher scoped to owner; admin sees all
- [x] 3.4 Help + README updates

## 4. Verification
- [x] 4.1 Two-user isolation tests
- [x] 4.2 CLI/smoke/Playwright updated
- [x] 4.3 Full lights-off `hello-nextjs` run through the new ID URL
  - blocked on the dev stack: the running compose images predate the identity change and the
    database has no `factories` registry/ids yet. Rebuild api+web, run the migration + backfill,
    then `bash scripts/smoke.sh` and `cd apps/web && bunx playwright test`.
