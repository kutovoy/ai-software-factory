-- Scoring and measurement read model (Phase 4a, ADR-016/ADR-017).
--
-- Scores are append-only in spirit: a row is upserted only for the same
-- (run_id, scorer, rubric_hash) triple, so re-scoring the same frozen corpus with the same
-- rubric is idempotent while a rubric change produces a new row with its own hash.
-- Nothing here changes the run/event contract: scoring consumes runs, it never writes them.

create table if not exists scorer_definitions (
  factory           text not null,
  name              text not null,
  scorer_class      text not null check (scorer_class in ('deterministic', 'judge')),
  rubric_hash       text not null,
  judge_model       text not null,
  labels            jsonb not null default '[]'::jsonb,
  passing_score     numeric(4, 3) not null,
  sampling_rate     integer not null,
  self_improvement  boolean not null default false,
  checks            jsonb not null default '[]'::jsonb,
  body              text not null default '',
  definition_commit text,
  updated_at        timestamptz not null default now(),
  primary key (factory, name, rubric_hash)
);

create index if not exists scorer_definitions_factory_idx
  on scorer_definitions (factory, name, updated_at desc);

-- One row per scoring pass (scheduled or on-demand). A batch may cover many runs and
-- scorers; per-score rows live in `scores`.
create table if not exists score_runs (
  id               text primary key,
  factory          text not null,
  run_id           text,
  work_item_id     text,
  stage            text,
  trigger          text not null check (trigger in ('scheduled', 'on_demand')),
  status           text not null default 'running' check (status in ('running', 'completed', 'error')),
  scorers          integer not null default 0,
  scored           integer not null default 0,
  skipped          integer not null default 0,
  errored          integer not null default 0,
  budget_exhausted boolean not null default false,
  window_days      integer,
  error            text,
  started_at       timestamptz not null default now(),
  ended_at         timestamptz
);

create index if not exists score_runs_factory_idx on score_runs (factory, started_at desc);
create index if not exists score_runs_run_idx on score_runs (run_id);

create table if not exists scores (
  id                  text primary key,
  score_run_id        text references score_runs(id) on delete set null,
  factory             text not null,
  run_id              text not null references runs(id) on delete cascade,
  work_item_id        text,
  stage               text,
  scorer              text not null,
  scorer_class        text not null check (scorer_class in ('deterministic', 'judge')),
  rubric_hash         text not null,
  status              text not null default 'ok' check (status in ('ok', 'error', 'skipped')),
  error_code          text,
  label               text,
  score               numeric(4, 3),
  passing             boolean not null default false,
  rationale           text,
  evidence_refs       jsonb not null default '[]'::jsonb,
  uncalibrated        boolean not null default false,
  judge_model         text,
  judge_model_version text,
  prompt_hash         text,
  input_tokens        bigint,
  output_tokens       bigint,
  cost_usd            numeric(12, 6),
  created_at          timestamptz not null default now(),
  unique (run_id, scorer, rubric_hash)
);

create index if not exists scores_factory_idx on scores (factory, created_at desc);
create index if not exists scores_run_idx on scores (run_id);
create index if not exists scores_work_item_idx on scores (work_item_id);
create index if not exists scores_stage_idx on scores (stage);
create index if not exists scores_scorer_idx on scores (factory, scorer, created_at desc);
create index if not exists scores_uncalibrated_idx on scores (factory, uncalibrated) where uncalibrated;

create table if not exists score_evidence (
  score_id text not null references scores(id) on delete cascade,
  kind     text not null,
  ref      text not null,
  detail   jsonb not null default '{}'::jsonb,
  primary key (score_id, kind, ref)
);

create index if not exists score_evidence_ref_idx on score_evidence (kind, ref);

-- Append-only score event log (`score.completed`, `score.skipped`). Deduped by
-- (score_id, type), so a retried persist activity emits exactly one event per score.
create table if not exists score_events (
  id         bigserial primary key,
  score_id   text not null references scores(id) on delete cascade,
  factory    text not null,
  run_id     text not null,
  type       text not null,
  payload    jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (score_id, type)
);

create index if not exists score_events_factory_idx on score_events (factory, id);
create index if not exists score_events_run_idx on score_events (run_id, id);

-- Golden sets: hand-labelled examples used to calibrate a judge. A set belongs to one
-- scorer; items reference the run the human graded.
create table if not exists calibration_sets (
  id        text primary key,
  factory   text not null,
  scorer    text not null,
  name      text not null,
  min_size  integer not null default 20,
  threshold numeric(4, 3) not null default 0.800,
  tolerance numeric(4, 3) not null default 0.250,
  created_at timestamptz not null default now()
);

create index if not exists calibration_sets_scorer_idx
  on calibration_sets (factory, scorer, created_at desc);

create table if not exists calibration_items (
  id          bigserial primary key,
  set_id      text not null references calibration_sets(id) on delete cascade,
  run_id      text references runs(id) on delete set null,
  work_item_id text,
  human_label text not null,
  human_score numeric(4, 3) not null,
  notes       text,
  created_at  timestamptz not null default now()
);

create index if not exists calibration_items_set_idx on calibration_items (set_id);

create table if not exists calibration_results (
  id                       bigserial primary key,
  set_id                   text not null references calibration_sets(id) on delete cascade,
  factory                  text not null,
  scorer                   text not null,
  rubric_hash              text not null,
  judge_model              text not null,
  judge_model_version      text,
  sample_size              integer not null,
  agreement_exact          numeric(5, 4),
  agreement_within_tolerance numeric(5, 4),
  tolerance                numeric(4, 3) not null,
  threshold                numeric(4, 3) not null,
  confusion                jsonb not null default '{}'::jsonb,
  verdict                  text not null check (verdict in ('pass', 'fail', 'insufficient_data')),
  created_at               timestamptz not null default now()
);

create index if not exists calibration_results_lookup_idx
  on calibration_results (factory, scorer, rubric_hash, created_at desc);
