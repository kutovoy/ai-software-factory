-- Run read model (ADR-010). Derived from Temporal workflow state: losing this schema
-- loses no run. Every row is written by activities keyed by `runId + stepId`, so the
-- tables are safe to rebuild by replaying event logs.

create table if not exists runs (
  id                 text primary key,
  factory            text not null,
  definition_commit  text not null,
  definition_dirty   boolean not null default false,
  harness            text not null,
  model              text,
  runner             text not null,
  kind               text not null default 'run',
  title              text,
  input              jsonb not null default '{}'::jsonb,
  status             text not null default 'pending',
  workflow_id        text not null,
  temporal_run_id    text,
  session_ref        text,
  summary            text,
  error              text,
  -- Cancellation is requested through the read model so the pump activity (which may be
  -- blocked on the harness) sees it across worker restarts.
  cancel_requested_at timestamptz,
  cancel_reason      text,
  started_at         timestamptz not null default now(),
  ended_at           timestamptz,
  cost_usd           numeric(12, 6),
  input_tokens       bigint,
  output_tokens      bigint,
  artifacts          jsonb not null default '[]'::jsonb,
  created_at         timestamptz not null default now()
);

create index if not exists runs_started_at_idx on runs (started_at desc);
create index if not exists runs_factory_status_idx on runs (factory, status);
create index if not exists runs_workflow_id_idx on runs (workflow_id);

-- Coarse workflow steps (lease, harness, stream, artifacts, persist). Not a per-token
-- trace: those live in the append-only event log.
create table if not exists run_steps (
  run_id      text not null references runs(id) on delete cascade,
  step_id     text not null,
  kind        text not null,
  status      text not null,
  detail      jsonb,
  error       text,
  started_at  timestamptz not null default now(),
  ended_at    timestamptz,
  primary key (run_id, step_id)
);

create index if not exists run_steps_run_idx on run_steps (run_id, started_at);

-- Append-only canonical FactoryEvent log (mirrors runs/<runId>/events.jsonl).
-- seq is assigned by the adapter's single sequencer; the PK makes retries idempotent.
create table if not exists events (
  run_id   text not null references runs(id) on delete cascade,
  seq      integer not null,
  type     text not null,
  ts       bigint not null,
  payload  jsonb not null,
  step_id  text,
  primary key (run_id, seq)
);

create index if not exists events_run_seq_idx on events (run_id, seq);
create index if not exists events_run_type_idx on events (run_id, type);

-- Interactive permission round-trip. The API writes the decision; the pump activity
-- polls it and forwards it to the harness (works across worker restarts).
create table if not exists run_permissions (
  run_id        text not null references runs(id) on delete cascade,
  request_id    text not null,
  action        text not null,
  detail        jsonb not null default '{}'::jsonb,
  decision      text check (decision in ('allow', 'deny', 'always')),
  requested_at  timestamptz not null default now(),
  decided_at    timestamptz,
  primary key (run_id, request_id)
);

create index if not exists run_permissions_pending_idx
  on run_permissions (run_id) where decision is null;

-- Inference proxy tokens (ADR-011). Only the hash is stored; the plaintext token lives
-- in the runner env for the duration of the run and is revoked at run end.
create table if not exists proxy_tokens (
  token_hash  text primary key,
  token_id    text not null,
  run_id      text not null references runs(id) on delete cascade,
  models      jsonb not null default '[]'::jsonb,
  created_at  timestamptz not null default now(),
  revoked_at  timestamptz
);

create index if not exists proxy_tokens_run_idx on proxy_tokens (run_id);

-- Proxy attempts: model + status + latency only. Never prompts, never credentials.
create table if not exists proxy_attempts (
  id          bigserial primary key,
  run_id      text not null references runs(id) on delete cascade,
  token_id    text,
  model       text,
  status      integer not null,
  ok          boolean not null,
  latency_ms  integer not null,
  error       text,
  streamed    boolean not null default false,
  created_at  timestamptz not null default now()
);

create index if not exists proxy_attempts_run_idx on proxy_attempts (run_id, created_at);
