# Design

## Decisions

1. **Hard delete, cascading sessions.** The schema already has `on delete cascade` for sessions and
   `on delete set null` for ownership columns, so one `delete from users` is enough; no tombstone.
2. **Two guards.** Self-deletion is refused (`invalid_user`) because it would immediately invalidate
   the caller's session mid-request. Deleting the last active admin is refused so a deployment cannot
   lock itself out.
3. **UI confirms.** The Delete button is disabled for the signed-in account and asks for confirmation;
   the API remains the authority.
4. **Tests clean up.** The E2E flow deletes the account it created, exercising the route and keeping
   the development database clean.
