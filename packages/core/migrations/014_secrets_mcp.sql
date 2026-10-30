-- Secrets registry + MCP wiring (change `add-secrets-and-mcp`, ADR-026/ADR-027).
--
-- The registry stores NAMES, never values (ADR-026): `secrets` is metadata only, presence
-- is checked against the runtime environment at read time and reported as
-- `resolved`/`unresolved`. `run_secrets` records which names a run resolved (no values),
-- and `secret_usage` is the per-name aggregate the Secrets page reads.
--
-- `mcp_servers`/`mcp_bindings` are a derived index of the git-backed definition: the
-- definition is authoritative, these tables exist so the console can show status and the
-- last probe result without re-reading git on every render.
--
-- Numbering note: the change's task text said `012_secrets_mcp.sql`, but `012` and `013`
-- are already taken by `harden-runtime`; this is `014`.

create table if not exists secrets (
  name            text primary key,
  -- Where the value lives: `env` (process environment) or `managed` (external store).
  provider        text not null default 'env',
  scope           text not null default 'factory',
  description     text,
  last_rotated_at timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists secrets_provider_idx on secrets (provider);

-- Per-name usage aggregate. Deliberately no FK to `secrets`: a run may resolve a name
-- that is not registered yet (fresh checkout), and that must still be auditable.
create table if not exists secret_usage (
  secret_name  text primary key,
  use_count    bigint not null default 0,
  last_run_id  text,
  last_used_at timestamptz
);

-- Which secret *names* a run resolved. `(run_id, secret_name)` makes a retried lease
-- idempotent. No values, ever.
create table if not exists run_secrets (
  run_id      text not null,
  secret_name text not null,
  resolved    boolean not null,
  recorded_at timestamptz not null default now(),
  primary key (run_id, secret_name)
);

create index if not exists run_secrets_name_idx on run_secrets (secret_name, recorded_at desc);

create table if not exists mcp_servers (
  factory    text not null,
  name       text not null,
  transport  text not null check (transport in ('stdio', 'http')),
  command    text,
  args       jsonb not null default '[]'::jsonb,
  -- key -> secret NAME (never a value).
  env        jsonb not null default '{}'::jsonb,
  url        text,
  -- header -> secret NAME (never a value).
  headers    jsonb not null default '{}'::jsonb,
  status     text not null default 'untested'
             check (status in ('untested', 'healthy', 'unhealthy')),
  updated_at timestamptz not null default now(),
  primary key (factory, name)
);

create table if not exists mcp_bindings (
  factory     text not null,
  agent       text not null,
  server      text not null,
  -- Permission globs the agent receives for this server (`<server>*`).
  tools_allow jsonb not null default '[]'::jsonb,
  tools_deny  jsonb not null default '[]'::jsonb,
  updated_at  timestamptz not null default now(),
  primary key (factory, agent, server)
);

create index if not exists mcp_bindings_server_idx on mcp_bindings (factory, server);

-- Transport-level probe results. The probe runs in the runner/worker (ADR-010), never in
-- the API process; `runner_id` records where it executed.
create table if not exists mcp_tests (
  id          bigserial primary key,
  factory     text not null,
  server      text not null,
  transport   text not null,
  ok          boolean not null,
  latency_ms  integer,
  error       text,
  runner_id   text,
  created_at  timestamptz not null default now()
);

create index if not exists mcp_tests_server_idx on mcp_tests (factory, server, created_at desc);
