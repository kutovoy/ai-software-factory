-- Retention and quota read-path indexes (change `add-retention-quotas-promotion`).
--
-- The retention sweep ranks terminal runs per factory by their age and the budget/quota
-- admission checks sum spend in a calendar window and count pending/running runs. The
-- existing `(factory, status)` index cannot serve the ordered scan or the window filter, so
-- add a composite index and a partial index for the live-run count.

create index if not exists runs_factory_started_idx
  on runs (factory, started_at desc);

create index if not exists runs_factory_status_started_idx
  on runs (factory, status, started_at desc);

create index if not exists runs_factory_active_idx
  on runs (factory)
  where status in ('pending', 'running');
