# Design

## Decisions

1. **API owns the purge.** The API has DB, Temporal and runs-dir access; the CLI authenticates and calls
   `DELETE /api/v1/factories/:factoryId`. No direct DB connection in the script.
2. **Fail closed.** If the DB or Temporal client is unavailable, the purge fails before deleting anything.
3. **Transaction + verification.** Delete root rows by factory key (child rows cascade), verify no rows remain,
   then delete the registry row. A failure rolls back.
4. **Temporal.** Delete schedules whose IDs belong to the factory and terminate running workflows for its work
   items. Closed histories stay until Temporal retention (documented limitation).
5. **Artifacts.** Collect run ids before the DB delete, then remove `runs/<run_id>/`; keep git/forge by default.
6. **Authorization.** Owner or admin; active work requires `force`; unauthorized is 404.
