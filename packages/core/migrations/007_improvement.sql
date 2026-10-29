-- Self-improvement read model (Phase 5, ADR-020).
--
-- An improvement run observes a scored corpus, dedupes proposals, probes edits
-- contrastively, composes winners into a candidate definition and decides by authority.
-- Definitions (including `improvement.authority`) stay in git: the DB indexes proposals,
-- probes, lessons and events so the console can project them.
--
-- Idempotency: an improvement run is keyed by its id; a proposal is deduped on
-- `(improvement_run_id, cluster_key)`; an edit on `(proposal_id, kind, path)`; a probe on
-- `(proposal_id, edit_id, work_item_id)`; an event on `(improvement_run_id, type, subject)`.
-- A Temporal retry therefore never writes a duplicate.

create table if not exists improvement_runs (
  id               text primary key,
  factory          text not null,
  definition_commit text not null,
  trigger          text not null check (trigger in ('scheduled', 'on_demand')),
  status           text not null default 'queued'
                   check (status in ('queued', 'running', 'completed', 'error', 'skipped')),
  authority        text not null default 'propose_only',
  eligibility      jsonb not null default '{}'::jsonb,
  proposals        integer not null default 0,
  lessons          integer not null default 0,
  decision         text,
  error            text,
  workflow_id      text,
  temporal_run_id  text,
  started_at       timestamptz not null default now(),
  ended_at         timestamptz
);

create index if not exists improvement_runs_factory_idx
  on improvement_runs (factory, started_at desc);

create table if not exists proposals (
  id               text primary key,
  improvement_run_id text references improvement_runs(id) on delete set null,
  factory          text not null,
  kind             text not null default 'improvement'
                   check (kind in ('improvement', 'authority_change')),
  authority        text not null default 'propose_only',
  status           text not null default 'open'
                   check (status in ('open', 'accepted', 'rejected', 'no_improvement',
                                     'pr_open', 'merged', 'canary_not_available', 'failed')),
  title            text not null,
  summary          text not null default '',
  impact           numeric(12, 6) not null default 0,
  evidence         jsonb not null default '{}'::jsonb,
  failure_signature text not null default '',
  files            jsonb not null default '[]'::jsonb,
  diff             jsonb not null default '[]'::jsonb,
  candidate_hash   text,
  cluster_key      text not null default '',
  pr_url           text,
  pr_number        integer,
  decision_actor   text,
  decision_reason  text,
  decided_at       timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists proposals_factory_idx
  on proposals (factory, created_at desc);
create index if not exists proposals_rank_idx
  on proposals (factory, status, impact desc);
create unique index if not exists proposals_dedupe_idx
  on proposals (improvement_run_id, cluster_key);

create table if not exists proposal_edits (
  id             text primary key,
  proposal_id    text not null references proposals(id) on delete cascade,
  kind           text not null check (kind in ('invariant', 'domain')),
  path           text not null,
  rationale      text not null default '',
  content        text not null default '',
  scope          text not null default 'in_scope'
                 check (scope in ('in_scope', 'out_of_scope')),
  rejected       boolean not null default false,
  rejection_code text,
  contrast       jsonb,
  created_at     timestamptz not null default now(),
  unique (proposal_id, kind, path)
);

create index if not exists proposal_edits_proposal_idx
  on proposal_edits (proposal_id);

create table if not exists probes (
  id             text primary key,
  proposal_id    text not null references proposals(id) on delete cascade,
  edit_id        text not null references proposal_edits(id) on delete cascade,
  work_item_id   text,
  run_id         text,
  matched_inputs jsonb not null default '{}'::jsonb,
  baseline_score numeric(4, 3),
  candidate_score numeric(4, 3),
  delta          numeric(5, 3),
  winner         boolean not null default false,
  created_at     timestamptz not null default now(),
  unique (proposal_id, edit_id, work_item_id)
);

create index if not exists probes_proposal_idx on probes (proposal_id);

-- Experience library: per-factory by default. `promoted` rows are visible to other
-- factories as suggestions (never auto-applied).
create table if not exists lessons (
  id             text primary key,
  factory        text not null,
  cue            text not null,
  lesson         text not null,
  evidence       jsonb not null default '{}'::jsonb,
  confidence     numeric(4, 3) not null default 0,
  proposal_id    text references proposals(id) on delete set null,
  origin_factory text not null,
  promoted       boolean not null default false,
  promoted_by    text,
  promoted_at    timestamptz,
  created_at     timestamptz not null default now()
);

create index if not exists lessons_factory_idx
  on lessons (factory, created_at desc);
create index if not exists lessons_shared_idx
  on lessons (promoted, created_at desc) where promoted;

create table if not exists improvement_events (
  id                 bigserial primary key,
  improvement_run_id text not null references improvement_runs(id) on delete cascade,
  factory            text not null,
  type               text not null,
  subject            text not null default '',
  payload            jsonb not null default '{}'::jsonb,
  created_at         timestamptz not null default now(),
  unique (improvement_run_id, type, subject)
);

create index if not exists improvement_events_run_idx
  on improvement_events (improvement_run_id, id);

-- Phase 5b placeholder: canary rollouts are recorded here once the rollout workflow ships.
create table if not exists canary_rollouts (
  id                      text primary key,
  factory                 text not null,
  proposal_id             text not null references proposals(id) on delete cascade,
  candidate_version       text not null,
  stable_version          text not null,
  canary_percent          integer not null check (canary_percent between 1 and 100),
  rollback_threshold      numeric(4, 3) not null,
  observation_window_hours integer not null,
  status                  text not null default 'pending'
                          check (status in ('pending', 'active', 'promoted', 'rolled_back', 'unavailable')),
  reason                  text,
  started_at              timestamptz not null default now(),
  ended_at                timestamptz
);

create index if not exists canary_rollouts_factory_idx
  on canary_rollouts (factory, started_at desc);
