-- Factory loop read model (Phase 3a). Work items are records, not workflow variables: the
-- workflow id is derived from the work item id, so a worker restart reattaches to the same
-- item. Every row here is derived from Temporal workflow state; losing this schema loses no
-- loop, only the UI projection.

create table if not exists work_items (
  id                 text primary key,
  factory            text not null,
  type               text not null default 'task'
                     check (type in ('task', 'bug', 'incident', 'pr_review')),
  source             text not null default 'manual'
                     check (source in ('forge', 'slack', 'cron', 'manual')),
  -- Enough to reply to the original thread/issue: {kind, id, url, channel, threadId, ...}
  source_ref         jsonb not null default '{}'::jsonb,
  title              text not null,
  stage              text not null,
  status             text not null default 'active'
                     check (status in ('active', 'blocked', 'escalated', 'done', 'cancelled')),
  -- Lineage: a stage may spawn a follow-up item (e.g. a flaky test found during verify).
  parent_id          text references work_items(id) on delete set null,
  definition_commit  text not null,
  definition_dirty   boolean not null default false,
  pr_url             text,
  pr_number          integer,
  -- request_changes increments this; exceeding the configured limit escalates to a human.
  loop_count         integer not null default 0,
  workflow_id        text,
  input              jsonb not null default '{}'::jsonb,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists work_items_factory_stage_idx
  on work_items (factory, stage, status);
create index if not exists work_items_created_idx on work_items (created_at desc);
create index if not exists work_items_parent_idx on work_items (parent_id);
create index if not exists work_items_workflow_idx on work_items (workflow_id);

-- Append-only event log for the loop: stage.changed, gate.decided, review.verdict,
-- dispatch.denied, autonomy.paused, ... The raw material for scorers (Phase 4).
create table if not exists work_item_events (
  id            bigserial primary key,
  work_item_id  text not null references work_items(id) on delete cascade,
  type          text not null,
  stage         text,
  actor         text,
  payload       jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now()
);

create index if not exists work_item_events_item_idx
  on work_item_events (work_item_id, id);
create index if not exists work_item_events_type_idx
  on work_item_events (work_item_id, type);

-- One row per stage attempt. The API writes the human decision; the StageWorkflow records
-- the automatic (agent / SLA) decision. `workflow_id` is the child workflow currently
-- waiting, so `POST /work-items/:id/gates/:stage` can deliver the Temporal Update.
create table if not exists gate_decisions (
  work_item_id  text not null references work_items(id) on delete cascade,
  stage         text not null,
  attempt       integer not null default 1,
  gate          text not null,
  workflow_id   text,
  decision      text check (decision in ('approve', 'reject', 'request_changes')),
  actor         text,
  reason        text,
  feedback      text,
  automatic     boolean not null default false,
  requested_at  timestamptz not null default now(),
  sla_at        timestamptz,
  decided_at    timestamptz,
  primary key (work_item_id, stage, attempt)
);

create index if not exists gate_decisions_pending_idx
  on gate_decisions (work_item_id) where decision is null;

-- Global autonomy policy per factory + kill switch. `override_actor`/`override_reason`
-- records the explicit human override that lets autonomy be enabled while the benchmark
-- gate is still required (Phase 4 will satisfy it with real benchmarks).
create table if not exists autonomy_state (
  factory                 text primary key,
  enabled                 boolean not null default false,
  paused                  boolean not null default false,
  actor                   text,
  reason                  text,
  override_actor          text,
  override_reason         text,
  benchmark_gate_required boolean not null default false,
  updated_at              timestamptz not null default now()
);
