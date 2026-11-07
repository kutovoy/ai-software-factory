-- Long-running missions (roadmap item 12, change `add-long-running-missions`).
--
-- A mission is a durable goal above work items. It owns a plan, milestones, features,
-- checkpoints, events, gates, validations and budget. Work items remain the execution unit:
-- every mission feature is a work item that runs the existing factory stage graph.

create table if not exists missions (
  id                     text primary key,
  factory                text not null,
  factory_id             text,
  title                  text not null,
  goal                   text not null,
  status                 text not null default 'planning'
                         check (status in ('planning', 'awaiting_plan_approval', 'running',
                                           'paused', 'blocked', 'done', 'failed', 'cancelled')),
  definition_commit      text not null,
  definition_dirty       boolean not null default false,
  factory_root           text not null,
  definition_version     text not null default 'stable'
                         check (definition_version in ('stable', 'candidate')),
  canary_rollout_id      text,
  plan                   jsonb,
  plan_version           integer not null default 0,
  current_milestone_id   text,
  current_feature_id     text,
  workflow_id            text,
  attempt                integer not null default 1,
  budget                 jsonb not null default '{}'::jsonb,
  error                  text,
  cancel_requested_at    timestamptz,
  cancel_actor           text,
  cancel_reason          text,
  created_by             uuid references users(id) on delete set null,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

create index if not exists missions_factory_status_idx
  on missions (factory, status, created_at desc);
create index if not exists missions_created_by_idx on missions (created_by);
create index if not exists missions_workflow_idx on missions (workflow_id);

create table if not exists mission_milestones (
  id                 text primary key,
  mission_id         text not null references missions(id) on delete cascade,
  ordinal            integer not null,
  title              text not null,
  description        text not null default '',
  status             text not null default 'pending'
                     check (status in ('pending', 'running', 'validating', 'done', 'failed', 'blocked')),
  validation_round   integer not null default 0,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (mission_id, ordinal)
);

create index if not exists mission_milestones_mission_idx
  on mission_milestones (mission_id, ordinal);

create table if not exists mission_features (
  id                   text primary key,
  mission_id           text not null references missions(id) on delete cascade,
  milestone_id         text not null references mission_milestones(id) on delete cascade,
  ordinal              integer not null,
  title                text not null,
  description          text not null default '',
  status               text not null default 'pending'
                       check (status in ('pending', 'ready', 'running', 'done', 'failed', 'skipped')),
  depends_on           jsonb not null default '[]'::jsonb,
  acceptance_check_ids jsonb not null default '[]'::jsonb,
  work_item_type       text not null default 'task',
  work_item_id         text references work_items(id) on delete set null,
  fix_for_feature_id   text references mission_features(id) on delete set null,
  attempt              integer not null default 0,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (mission_id, ordinal)
);

create index if not exists mission_features_mission_idx
  on mission_features (mission_id, ordinal);
create index if not exists mission_features_milestone_idx
  on mission_features (milestone_id, status);
create index if not exists mission_features_work_item_idx
  on mission_features (work_item_id);

create table if not exists mission_checkpoints (
  id           bigserial primary key,
  mission_id   text not null references missions(id) on delete cascade,
  seq          integer not null,
  kind         text not null,
  milestone_id text,
  feature_id   text,
  dedupe_key   text,
  state        jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  unique (mission_id, seq)
);

create unique index if not exists mission_checkpoints_dedupe_idx
  on mission_checkpoints (mission_id, dedupe_key) where dedupe_key is not null;
create index if not exists mission_checkpoints_mission_idx
  on mission_checkpoints (mission_id, seq);

create table if not exists mission_events (
  id           bigserial primary key,
  mission_id   text not null references missions(id) on delete cascade,
  type         text not null,
  milestone_id text,
  feature_id   text,
  actor        text,
  payload      jsonb not null default '{}'::jsonb,
  dedupe_key   text,
  created_at   timestamptz not null default now()
);

create unique index if not exists mission_events_dedupe_idx
  on mission_events (mission_id, dedupe_key) where dedupe_key is not null;
create index if not exists mission_events_mission_idx
  on mission_events (mission_id, id);

create table if not exists mission_gates (
  mission_id   text not null references missions(id) on delete cascade,
  gate         text not null,
  attempt      integer not null default 1,
  workflow_id  text,
  decision     text check (decision in ('approve', 'reject', 'request_changes')),
  actor        text,
  reason       text,
  feedback     text,
  requested_at timestamptz not null default now(),
  sla_at       timestamptz,
  decided_at   timestamptz,
  primary key (mission_id, gate, attempt)
);

create index if not exists mission_gates_pending_idx
  on mission_gates (mission_id) where decision is null;

create table if not exists mission_validations (
  id           text primary key,
  mission_id   text not null references missions(id) on delete cascade,
  milestone_id text not null references mission_milestones(id) on delete cascade,
  round        integer not null,
  kind         text not null check (kind in ('scrutiny', 'user-testing', 'contract')),
  run_id       text,
  status       text not null default 'pending'
               check (status in ('pending', 'running', 'passed', 'failed', 'error')),
  verdict      text check (verdict in ('approve', 'reject', 'needs_human')),
  findings     jsonb not null default '[]'::jsonb,
  evidence     jsonb not null default '[]'::jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists mission_validations_mission_idx
  on mission_validations (mission_id, milestone_id, round);
create index if not exists mission_validations_run_idx
  on mission_validations (run_id);

alter table work_items
  add column if not exists mission_id text references missions(id) on delete set null;
alter table work_items
  add column if not exists mission_feature_id text references mission_features(id) on delete set null;

create index if not exists work_items_mission_idx
  on work_items (mission_id, created_at desc);
create index if not exists work_items_mission_feature_idx
  on work_items (mission_feature_id);

alter table work_items drop constraint if exists work_items_source_check;
alter table work_items add constraint work_items_source_check
  check (source in ('forge', 'slack', 'cron', 'manual', 'sentry', 'posthog', 'linear', 'jira', 'api', 'mission'));

alter table runs
  add column if not exists mission_id text references missions(id) on delete set null;

create index if not exists runs_mission_idx
  on runs (mission_id, started_at desc);
