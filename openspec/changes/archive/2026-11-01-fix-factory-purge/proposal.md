# Proposal

## Why

`bun scripts/delete-factory.ts hello-nextjs --yes` left 32 runs, 5 work items, events and steps behind because
`DATABASE_URL` was unset in the shell; the script skipped the DB purge. It also only pauses Temporal schedules,
never terminates workflows, and leaves `runs/<id>/` artifacts. Reusing the name then shows old data.

## What Changes

- **Fail closed:** the purge requires a working DB connection; no silent skip.
- **Complete DB purge:** delete every factory-scoped row in one transaction and verify zero remain.
- **Temporal:** delete schedules and terminate running workflows; closed histories remain until retention.
- **Artifacts:** delete the factory's `runs/<id>/` directories.
- **Keep:** git history, forge repository and PRs by default.
- **Safety:** dry-run/report, active-work refusal unless forced, owner/admin authorization.
- **CLI:** `delete-factory` logs in, calls the API purge endpoint, removes the directory and prints the commit.

## Capabilities

### New Capabilities
- `factory-purge`: complete, verified removal of a factory.

## Impact

- New API delete route; CLI rewrite; no schema change beyond identity.
