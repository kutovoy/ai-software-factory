-- Canary rollout + deterministic-hash routing (Phase 5b, ADR-021).
--
-- A work item is assigned to `stable` or `candidate` exactly once, at creation, by
-- `sha256(workItemId) % 100 < canaryPercent`. The assignment is persisted on the item so
-- every stage of that item runs the same version and the split is auditable after the
-- rollout ends. The rollout itself is a row in `canary_rollouts` (created by 007) plus an
-- append-only `canary_events` log for `canary.started/promoted/rolled_back`.
--
-- Idempotency: rollout rows are keyed by a deterministic id; events dedupe on
-- `(rollout_id, type, subject)`, so a Temporal retry never writes a duplicate.

alter table work_items add column if not exists canary_rollout_id text;
alter table work_items add column if not exists definition_version text not null default 'stable';

create index if not exists work_items_canary_idx
  on work_items (factory, canary_rollout_id);

alter table canary_rollouts add column if not exists candidate_commit text;
alter table canary_rollouts add column if not exists stable_commit text;
alter table canary_rollouts add column if not exists candidate_root text;
alter table canary_rollouts add column if not exists pr_url text;
alter table canary_rollouts add column if not exists pr_number integer;
alter table canary_rollouts add column if not exists actor text;
alter table canary_rollouts add column if not exists evidence jsonb not null default '{}'::jsonb;

-- A proposal whose canary rollout is live is `canary`; a rolled-back one is `rolled_back`.
alter table proposals drop constraint if exists proposals_status_check;
alter table proposals add constraint proposals_status_check
  check (status in ('open', 'accepted', 'rejected', 'no_improvement', 'pr_open', 'merged',
                    'canary_not_available', 'canary', 'rolled_back', 'failed'));

create table if not exists canary_events (
  id          bigserial primary key,
  rollout_id  text not null references canary_rollouts(id) on delete cascade,
  factory     text not null,
  type        text not null,
  subject     text not null default '',
  payload     jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  unique (rollout_id, type, subject)
);

create index if not exists canary_events_rollout_idx
  on canary_events (rollout_id, id);
create index if not exists canary_events_factory_idx
  on canary_events (factory, created_at desc);
