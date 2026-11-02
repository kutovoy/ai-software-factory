# Design

## Decisions

1. **ID in the definition.** `id` is optional in the schema for backwards-compatible fixtures, but the runtime
   loader requires it (`factory_id_missing`). `fac_<ulid>` is generated once and committed.
2. **Registry.** `factories(id, owner_id, name, key, path, alias, created_at, updated_at)` with unique `id`,
   `key`, `path` and `(owner_id, name)`. The API syncs definitions into the registry on list/get/create.
3. **Legacy compatibility.** Existing top-level `factories/<name>` directories stay in place and are admin-owned;
   their key is `<name>`. New factories use `factories/<owner>/<name>` and key `<owner>/<name>`. This avoids
   moving fixtures and keeps the current readiness PR intact.
4. **Internal key vs URL ID.** DB tables keep the existing `factory` text as the unique internal key; work items
   and runs also store `factory_id`. URLs and API paths use the opaque ID only.
5. **Nested-only API.** `/api/v1/factories/:factoryId/…` replaces the name/global routes; no aliases. The
   OpenAPI contract, smoke and Playwright suites move in the same change.
6. **Ownership.** A member resolves only factories with `owner_id = user.id`; admins resolve all. Any other ID
   returns 404, never 403.
7. **Forge.** New factories default to `u-<owner>`; existing factories keep the owner declared in `factory.yaml`.
