-- Benchmark read model (Phase 4b, ADR-018/ADR-019).
--
-- A benchmark run is one execution of a (task × configuration) matrix pinned to a
-- definition commit. Trials are child runs; results are per-configuration aggregates;
-- attestations bind `(factory, definition_commit, config_hash)` and are consumed by the
-- autonomy gate. The git-backed definition stays the source of truth: nothing here edits it.

create table if not exists benchmark_runs (
  id               text primary key,
  factory          text not null,
  suite            text not null,
  definition_commit text not null,
  config_hash      text not null,
  status           text not null default 'queued'
                   check (status in ('queued', 'running', 'completed', 'error', 'cancelled')),
  tasks            jsonb not null default '[]'::jsonb,
  configurations   jsonb not null default '[]'::jsonb,
  matrix           jsonb not null default '[]'::jsonb,
  estimate_usd     numeric(12, 6),
  max_cost_usd     numeric(12, 6) not null default 0,
  spent_usd        numeric(12, 6) not null default 0,
  budget_exhausted boolean not null default false,
  partial          boolean not null default false,
  pass_rate        numeric(5, 4),
  calibration_ok   boolean not null default false,
  passed           boolean not null default false,
  error            text,
  workflow_id      text,
  temporal_run_id  text,
  started_at       timestamptz not null default now(),
  ended_at         timestamptz
);

create index if not exists benchmark_runs_factory_idx
  on benchmark_runs (factory, started_at desc);
create index if not exists benchmark_runs_lookup_idx
  on benchmark_runs (factory, definition_commit, config_hash, started_at desc);

create table if not exists benchmark_trials (
  id                 text primary key,
  benchmark_run_id   text not null references benchmark_runs(id) on delete cascade,
  factory            text not null,
  suite              text not null,
  configuration      text not null,
  task               text not null,
  run_id             text references runs(id) on delete set null,
  status             text not null default 'pending'
                     check (status in ('pending', 'running', 'ok', 'error', 'skipped')),
  error_code         text,
  score              numeric(4, 3),
  passing            boolean not null default false,
  cost_usd           numeric(12, 6) not null default 0,
  uncalibrated       boolean not null default false,
  starting_repo_refs jsonb not null default '[]'::jsonb,
  repo               text,
  definition_commit  text not null,
  config_hash        text not null,
  started_at         timestamptz not null default now(),
  ended_at           timestamptz,
  unique (benchmark_run_id, configuration, task)
);

create index if not exists benchmark_trials_run_idx
  on benchmark_trials (benchmark_run_id, configuration, task);
create index if not exists benchmark_trials_child_run_idx on benchmark_trials (run_id);

create table if not exists benchmark_results (
  benchmark_run_id text not null references benchmark_runs(id) on delete cascade,
  configuration    text not null,
  pass_rate        numeric(5, 4),
  weighted_score   numeric(4, 3),
  sample_size      integer not null default 0,
  passing_count    integer not null default 0,
  cost_usd         numeric(12, 6) not null default 0,
  errors           integer not null default 0,
  skipped          integer not null default 0,
  uncalibrated     boolean not null default false,
  labels           jsonb not null default '[]'::jsonb,
  frontier         boolean not null default false,
  dominated_by     text,
  primary key (benchmark_run_id, configuration)
);

create table if not exists benchmark_attestations (
  id                text primary key,
  factory           text not null,
  definition_commit text not null,
  suite             text not null,
  config_hash       text not null,
  pass_rate         numeric(5, 4),
  calibration_ok    boolean not null default false,
  passed            boolean not null default false,
  partial           boolean not null default false,
  benchmark_run_id  text references benchmark_runs(id) on delete set null,
  created_at        timestamptz not null default now(),
  unique (factory, definition_commit, config_hash)
);

create index if not exists benchmark_attestations_factory_idx
  on benchmark_attestations (factory, created_at desc);
create index if not exists benchmark_attestations_lookup_idx
  on benchmark_attestations (factory, definition_commit, config_hash);

-- Append-only benchmark event log (`benchmark.started`, `benchmark.completed`). Deduped by
-- (benchmark_run_id, type) so a retried activity emits exactly one event per run.
create table if not exists benchmark_events (
  id               bigserial primary key,
  benchmark_run_id text not null references benchmark_runs(id) on delete cascade,
  factory          text not null,
  type             text not null,
  payload          jsonb not null default '{}'::jsonb,
  created_at       timestamptz not null default now(),
  unique (benchmark_run_id, type)
);

create index if not exists benchmark_events_run_idx
  on benchmark_events (benchmark_run_id, id);
