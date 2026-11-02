# Proposal

## Why

Factory identity is the global directory name. Every factory page is `/factories/<name>/…`, the API is
name-based, and two users cannot own the same factory name. A member who guesses a name can reach another
user's factory pages unless every route is owner-checked. Factory names also leak through URLs, logs and links.

## What Changes

- **Stable factory ID:** `factory.yaml` gains `id: fac_<ulid>`; a `factories` registry maps id → owner, name,
  path and key. IDs survive a database rebuild.
- **Owner-scoped paths:** new factories live at `factories/<owner>/<name>`; legacy top-level directories remain
  admin-owned for compatibility. The internal factory key is the directory path (`owner/name`, or the legacy
  name); two users can use the same local name.
- **Nested URLs:** `/factories/<factory_id>/dashboard`, `/factories/<factory_id>/work-items/<id>`,
  `/factories/<factory_id>/runs/<id>`. No old-URL redirects.
- **Nested API only:** all factory resources move under `/api/v1/factories/:factoryId/…`; the old name/global
  routes are removed.
- **Ownership enforcement:** members see and mutate only their own factories; admins see all; unauthorized
  requests return 404.
- **Forge:** new factories default to `repositories.owner: u-<owner>`; legacy admin factories keep their
  declared owner.

## Capabilities

### New Capabilities
- `factory-identity`: stable IDs, ownership, owner-scoped paths and nested URLs.

## Impact

- New `factories` registry table; `factory_id` on work items and runs; migration/backfill.
- CLI, API, console routes, OpenAPI, smoke, Playwright, help and README change together.
- Breaking `/api/v1` shape (accepted; ADR records the exception to the prefix-bump rule).
