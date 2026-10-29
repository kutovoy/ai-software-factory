-- Merge queue + webhook automations read model (Phase 3b, ADR-022 / ADR-023).
--
-- NOTE: this file is numbered 009, not 008 as the task text says: `008_canary.sql` already
-- exists (Phase 5b). Migration order is lexical, so the merge/webhook schema lands after it.
--
-- The queue owns merges: an agent opens a PR and enqueues it; only a batch merge may write
-- the default branch. Every table is idempotent on its natural key so a Temporal retry never
-- writes a duplicate:
--   * merge_batches        — one row per batch; at most one in flight per factory
--   * merge_batch_items    — one row per (factory, pull request)
--   * merge_events         — append-only audit log deduped by (batch, type, subject)
--   * webhook_deliveries   — one row per (provider, delivery id)
--   * automation_schedules — one row per (factory, automation) + fire log
--   * integrations         — GitHub connection by secret reference (never a value)

create table if not exists integrations (
  id                 text primary key,
  factory            text not null,
  provider           text not null check (provider in ('github', 'gitlab', 'webhook')),
  -- Secret *names*; the values are resolved at run time (ADR-023), never stored here.
  secret_ref         text not null,
  webhook_secret_ref text,
  repos              jsonb not null default '[]'::jsonb,
  config             jsonb not null default '{}'::jsonb,
  dry_run            boolean not null default false,
  enabled            boolean not null default true,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (factory, provider)
);

create table if not exists merge_batches (
  id          text primary key,
  factory     text not null,
  repo        text not null,
  status      text not null default 'queued'
              check (status in ('queued', 'merging', 'verifying', 'merged', 'bisected',
                                'reverted', 'checks_timeout', 'failed')),
  batch_size  integer not null default 2,
  base_sha    text,
  merge_sha   text,
  checks      jsonb not null default '[]'::jsonb,
  evidence    jsonb not null default '{}'::jsonb,
  actor       text,
  reason      text,
  workflow_id text,
  created_at  timestamptz not null default now(),
  started_at  timestamptz,
  ended_at    timestamptz
);

create index if not exists merge_batches_factory_idx
  on merge_batches (factory, created_at desc);
-- At most one batch in flight per factory (spec `merge-queue` › single batch).
create unique index if not exists merge_batches_inflight_idx
  on merge_batches (factory) where status in ('queued', 'merging', 'verifying');

create table if not exists merge_batch_items (
  id           text primary key,
  batch_id     text references merge_batches(id) on delete cascade,
  factory      text not null,
  pr_number    integer not null,
  work_item_id text,
  head         text not null default '',
  status       text not null default 'queued'
               check (status in ('queued', 'batched', 'merged', 'reverted', 'needs_human', 'failed')),
  commit_sha   text,
  evidence     jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists merge_batch_items_batch_idx on merge_batch_items (batch_id);
create index if not exists merge_batch_items_queue_idx
  on merge_batch_items (factory, status, created_at);
create unique index if not exists merge_batch_items_unique_pr_idx
  on merge_batch_items (factory, pr_number) where status <> 'reverted';

create table if not exists merge_events (
  id         bigserial primary key,
  batch_id   text not null references merge_batches(id) on delete cascade,
  factory    text not null,
  type       text not null,
  subject    text not null default '',
  payload    jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (batch_id, type, subject)
);

create index if not exists merge_events_batch_idx on merge_events (batch_id, id);

create table if not exists webhook_deliveries (
  id            bigserial primary key,
  provider      text not null,
  delivery_id   text not null,
  event         text,
  action        text,
  factory       text,
  status        text not null
                check (status in ('received', 'accepted', 'ignored', 'rejected')),
  reason        text,
  work_item_id  text,
  sender        text,
  payload       jsonb not null default '{}'::jsonb,
  payload_bytes integer not null default 0,
  created_at    timestamptz not null default now(),
  unique (provider, delivery_id)
);

create index if not exists webhook_deliveries_provider_idx
  on webhook_deliveries (provider, created_at desc);
create index if not exists webhook_deliveries_factory_idx
  on webhook_deliveries (factory, created_at desc);

create table if not exists automation_schedules (
  id               text primary key,
  factory          text not null,
  automation       text not null,
  kind             text not null default 'cron' check (kind in ('cron', 'webhook')),
  cron             text,
  status           text not null default 'pending'
                   check (status in ('pending', 'active', 'paused', 'error')),
  temporal_schedule_id text,
  last_fire_at     timestamptz,
  last_work_item_id text,
  fire_count       integer not null default 0,
  last_error       text,
  updated_at       timestamptz not null default now(),
  unique (factory, automation)
);

create table if not exists automation_fires (
  id            bigserial primary key,
  schedule_id   text not null,
  fire_at       timestamptz not null,
  factory       text not null,
  automation    text not null,
  work_item_id  text,
  skipped       boolean not null default false,
  reason        text,
  created_at    timestamptz not null default now(),
  unique (schedule_id, fire_at)
);
