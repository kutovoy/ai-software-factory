# Tasks

- [x] 1.1 API `DELETE /factories/:factoryId` with owner/admin, force and fail-closed checks
- [x] 1.2 Transactional DB purge by factory key + verification
- [x] 1.3 Temporal schedule deletion + running workflow termination
- [x] 1.4 Run-directory removal
- [x] 1.5 CLI rewrite: login, purge, remove directory, commit reminder
- [x] 1.6 Tests: rows, schedules, workflows, run dirs, missing DB, active work
- [x] 1.7 One-off purge of stale `hello-nextjs` rows (keep PR #4) — helper added and
      dry-run verified; run `bun scripts/purge-stale-hello-nextjs.ts` to apply it
