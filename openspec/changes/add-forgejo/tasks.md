# Tasks

## 1. Compose (`compose.yaml`)

- [ ] 1.1 `forgejo` service (pinned image), `forgejo` database in the existing Postgres (init SQL), volume
      `forgejo-data`, healthcheck
- [ ] 1.2 Env: `FORGEJO__server__ROOT_URL=http://localhost:3000/extras/forgejo/`,
      `FORGEJO__server__STATIC_URL_PREFIX=/extras/forgejo`, `DOMAIN=localhost`, `HTTP_PORT=3000`,
      `REVERSE_PROXY_AUTHENTICATION=true`, `REVERSE_PROXY_AUTHENTICATION_USER=X-WebAuth-User`
- [ ] 1.3 Enable by default; `FORGEJO_ENABLED` documented for opting out (service profile)

## 2. Console proxy (`apps/web`)

- [ ] 2.1 Rewrite `/extras/forgejo/:path*` → `http://forgejo:3000/:path*`; inject `X-WebAuth-User`
- [ ] 2.2 Verify UI, assets, redirects and git-over-HTTP (`git clone http://localhost:3000/extras/forgejo/...`)
- [ ] 2.3 "Open Forgejo" link in Settings/Integrations; PR links resolve

## 3. Bootstrap (`scripts/forgejo-bootstrap.sh`)

- [ ] 3.1 Wait for health; create admin (idempotent), generate API token, create org + repo
- [ ] 3.2 Write `GITHUB_TOKEN`/`GITHUB_API_BASE_URL` to `.env` (secret reference only), restart api+worker
- [ ] 3.3 Idempotent re-runs; refuse to print the token

## 4. Forge backend

- [ ] 4.1 Point the `CodeForge` client at Forgejo (`GITHUB_API_BASE_URL`), token by reference
- [ ] 4.2 Fix Gitea/GitHub API differences found by a real run; contract suite stays green
- [ ] 4.3 Run `hello-nextjs` lights-off against Forgejo; PR URL resolves and is rendered on the item/dashboard

## 5. Docs & tests

- [ ] 5.1 ADR: single-user header auth now, OIDC + per-user orgs later (no Keycloak requirement)
- [ ] 5.2 Help entry: "Where results live" names the local forge; multi-user note
- [ ] 5.3 Smoke: forgejo healthy, `/extras/forgejo` 200 via console, bootstrap idempotent, PR URL reachable
- [ ] 5.4 `bun run ci`, smoke, Playwright, UI audit green; STATUS; `openspec validate add-forgejo`
