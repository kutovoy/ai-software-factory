-- Read-path indexes (performance plan, `docs/PERFORMANCE.md`).
--
-- These are scale measures, not the 7s fix: the measured SQL was already sub-millisecond.
-- The batch inbox/board projections filter by factory + owner and order newest-first, so
-- the composite indexes below keep those plans stable as the read models grow.
--
-- Production note: prefer `CREATE INDEX CONCURRENTLY` for the large tables. The migration
-- runner applies files inside a transaction, where `CONCURRENTLY` is not allowed; a
-- deployment can create the same indexes concurrently before running the migration.

create index if not exists runs_factory_started_idx
  on runs (factory, started_at desc);

create index if not exists runs_factory_status_started_idx
  on runs (factory, status, started_at desc);

create index if not exists work_items_factory_created_idx
  on work_items (factory, created_at desc);

create index if not exists work_items_factory_status_created_idx
  on work_items (factory, status, created_at desc);

-- Pending queues are sparse and always ordered by request time. The existing partial
-- indexes are keyed by run/work-item; these cover the inbox's "newest pending first" scan.
create index if not exists gate_decisions_pending_requested_idx
  on gate_decisions (requested_at desc) where decision is null;

create index if not exists run_permissions_pending_requested_idx
  on run_permissions (requested_at desc) where decision is null;
