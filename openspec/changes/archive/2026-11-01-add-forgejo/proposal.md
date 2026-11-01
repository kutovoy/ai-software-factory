# Proposal

## Why

Factory PR links point at `https://forge.local/...`, which resolves nowhere. The factory needs its own forge,
served by the console so links work, and the design must not paint us into a corner for multi-user.

## What Changes

- **Forgejo, enabled by default**, served at `/extras/forgejo` (configurable: image, admin user, enable flag).
  `ROOT_URL`/`STATIC_URL_PREFIX` carry the subpath; the console proxies the prefix to the forge.
- **Auto-login (single-user, v1):** Forgejo reverse-proxy header auth (`X-WebAuth-User`) injected by the console
  proxy. No Keycloak. This is explicitly a local/single-user mode; the console has no auth yet, so anyone who can
  reach the console is the seeded admin.
- **Multi-user path (documented, not built):** OIDC (Forgejo's own OIDC client) with group→organization/team
  mappings; one org per user; the console's Phase 6 auth gates the proxy header. Keycloak is an option, not a
  requirement — Forgejo also acts as an OAuth2 provider and simpler IdPs (Authentik/Zitadel) fit.
- **Real forge backend:** Forgejo's Gitea-compatible API is used by the existing `CodeForge` GitHub client
  (`GITHUB_API_BASE_URL=http://forgejo:3000/api/v1`), token by secret reference. PR URLs become Forgejo URLs that
  resolve from the laptop.
- **Bootstrap:** a script creates the admin, an API token (written to `.env` as a secret reference), the
  organization and repository.

## Capabilities

### New Capabilities
- `forge`: a self-hosted Forgejo instance as the factory's repository backend, with a documented identity path.

### Modified Capabilities
- `code-forge`: GitHub-compatible client works against Forgejo; PR URLs are forge URLs.

## Impact

- Compose gains `forgejo` (+ its database in the existing Postgres) and a volume; the console gains one rewrite.
- Git-over-HTTP through the console proxy is supported; SSH is out of scope in v1 (documented).
- No credential values in definitions or logs; the token is a secret reference.
