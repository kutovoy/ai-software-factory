# Design

## Decisions

1. **Opaque sessions, hashed at rest.** A 32-byte random token is set as `factory_session` (HttpOnly,
   SameSite=Lax, 7-day sliding expiry); only its SHA-256 hash is stored. No JWT, no signing key to rotate.
2. **Bootstrap admin.** On API start, if no user exists, create the admin from `FACTORY_ADMIN_EMAIL` /
   `FACTORY_ADMIN_PASSWORD`; if the password is unset, generate one and log it once. Compose supplies local
   development defaults and SECURITY.md warns not to expose them.
3. **`AUTH_REQUIRED` is the switch.** Default `0` for unit/integration tests and local development; compose sets
   `1`. Routes exempt from auth: `/health`, `/auth/login`, `/openapi.json`; everything else needs a session.
4. **Roles.** `admin` manages users and sees all work; `member` sees only items they created. Existing rows with
   a null `created_by` are admin-only.
5. **Cookie forwarding.** `apps/web` forwards the incoming cookie on server-side API calls and same-origin
   proxies; login responses forward `Set-Cookie` to the browser.
6. **Forge identity.** The proxy resolves the session via `/auth/me` and asserts `X-WebAuth-User: <username>`;
   with auth off it asserts `FORGEJO_ADMIN_USER`. Forgejo auto-registers reverse-proxy users. On login the API
   best-effort creates org `u-<username>` with the user as owner using the admin token.
7. **OIDC is deferred.** Group→org mapping is a config contract (`FORGEJO_OIDC_GROUP_MAP`) documented for the
   IdP phase; no IdP dependency ships now.
