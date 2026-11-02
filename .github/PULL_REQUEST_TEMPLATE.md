## What and why

<!-- The observable change and the problem it solves. Link the OpenSpec change if there is one. -->

## How

<!-- The approach in a few lines. Call out anything irreversible (schema, API shape, ports, secrets). -->

## Verification

<!-- Paste the commands you ran and their result. A behaviour change needs a test that fails without the patch. -->

- [ ] `bun run ci` (typecheck + unit tests + factory validation)
- [ ] `openspec validate <change>` when a change is in flight
- [ ] `docker compose config` (and the proxy override, if touched)
- [ ] Playwright flow(s) for user-visible console changes (`cd apps/web && bunx playwright test`)
- [ ] `bash scripts/smoke.sh` when runtime code changed

## Checklist

- [ ] README and `apps/web/src/lib/help.ts` are current for any feature, page or route change
- [ ] `apps/api/openapi.json` is updated when a route changed (contract test enforces it)
- [ ] No secrets, tokens or `.env` contents in the diff or logs
- [ ] Creator/attribution (`NOTICE`) left intact
