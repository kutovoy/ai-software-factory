# Design

## Decisions

1. **Subpath hosting.** Forgejo sets `[server] ROOT_URL = http://localhost:3000/extras/forgejo/` and
   `STATIC_URL_PREFIX = /extras/forgejo`. The console rewrites `/extras/forgejo/:path*` to the forge and strips
   the prefix (Next rewrite), so generated links and assets stay on the console origin.
2. **No second reverse proxy in v1.** A Next rewrite is enough for the web UI and git-over-HTTP. SSH and
   websockets are out of scope and documented.
3. **Auto-login by trusted header.** Forgejo `REVERSE_PROXY_AUTHENTICATION=true` with
   `REVERSE_PROXY_AUTHENTICATION_USER=X-WebAuth-User`; the console injects the seeded admin for every request.
   Only the console can reach the forge (internal network), so the header cannot be spoofed from outside.
   This is single-user; it is stated in the UI and docs.
4. **Multi-user.** Phase 6 adds console auth; the proxy injects the *authenticated* user instead of the admin,
   and Forgejo OIDC group mappings place users in per-user organizations/teams. Keycloak is optional.
5. **Forge backend.** Forgejo exposes a Gitea-compatible API; reuse `packages/forge/github.ts` with the forge base
   URL. Where Gitea differs (e.g. ref/status endpoints), adapt behind the same contract and keep the fake-forge
   contract suite green.
6. **Secrets.** `GITHUB_TOKEN` stays a name; the bootstrap writes the token to `.env` only.

## Risks

- Proxy-through-Next may choke on very large pushes; acceptable for this scale, and a dedicated proxy can replace
  it later without changing URLs.
- Header auth is only safe while the forge is not publicly reachable; the compose network keeps it internal.
- Gitea API drift from GitHub may require small compatibility fixes; the contract suite is the guard.
