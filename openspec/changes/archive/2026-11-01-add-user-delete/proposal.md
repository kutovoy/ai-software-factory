# Proposal

## Why

The Users page can create, promote and disable accounts but not remove them. Every Playwright run
creates a unique `e2e-user-…` account and leaves it behind, so a development database accumulates
test admins; operators also have no way to remove a departed user.

## What Changes

- `DELETE /api/v1/users/:id` (admin only) removes an account and cascades its sessions.
- Guards: an admin cannot delete their own account, and the last active admin cannot be deleted.
- The Users page gets a Delete action with confirmation; self-delete is disabled.
- The auth E2E test deletes the user it creates, so runs no longer accumulate accounts.
- Help documents deletion and the guards.

## Capabilities

### Modified Capabilities
- `console-auth`: user administration gains deletion with safety guards.

## Impact

- Additive API route + OpenAPI entry; no migration (the users/sessions schema already cascades).
- `work_items.created_by` / `runs.created_by` become null for deleted users (admin-only rows).
