# Proposal

## Why

The console and the API are unauthenticated, the Users page is a stub, and the Forgejo proxy asserts a single
seeded admin for every visitor. The next phase needs real identities: sign-in, roles, per-user project scope, and
a forge identity that matches the signed-in user.

## What Changes

- **Accounts and sessions:** `users` + `sessions` tables, argon2id password hashes, opaque session tokens stored
  hashed, HttpOnly cookie, login/logout/me routes, bootstrap admin from env.
- **Enforcement:** API middleware requires a session when `AUTH_REQUIRED=1` (compose default); health, login and
  the OpenAPI document stay public. The console redirects unauthenticated visitors to `/login`.
- **Users page:** list, create, change role and disable; admin-only.
- **Project scope:** work items carry `created_by`; non-admin list/detail endpoints only return the caller's
  items, and run/inbox queries follow the same owner.
- **Forge identity:** the Forgejo proxy asserts the session username (falling back to the seeded admin only when
  auth is off); reverse-proxy auto-registration is enabled; each user gets a best-effort personal organization
  `u-<username>`.
- **OIDC mapping (documented, not built):** `FORGEJO_OIDC_GROUP_MAP` reserves group→org mappings for the IdP
  phase; no external IdP is required for this change.

## Capabilities

### New Capabilities
- `console-auth`: sign-in, sessions, roles, user administration and per-user scope.
- `forge-identity`: the forge sees the signed-in user, not a shared admin.

## Impact

- Migration 016 adds `users`, `sessions` and `work_items.created_by`.
- API and console routes gain auth; smoke and Playwright log in with the bootstrap admin.
- Default compose credentials are local-development only and are documented as such.
