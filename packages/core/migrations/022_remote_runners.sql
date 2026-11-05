-- Remote runner hosts + observability (change `add-remote-runners`).
--
-- The remote host runs a runner agent, not a Temporal worker and not a Postgres client.
-- This schema is the central control plane: enrollment, host registry, command queue,
-- leases, host metrics and alert state. The agent talks to the API over outbound HTTP(S)
-- with a bearer token; the worker talks to the same tables directly.

create table if not exists runner_enrollments (
  id             text primary key,
  token_hash     text not null unique,
  name           text,
  platform       text,
  arch           text,
  pool           text,
  labels         jsonb not null default '{}'::jsonb,
  max_concurrent integer,
  owner          text,
  preflight      jsonb,
  created_at     timestamptz not null default now(),
  expires_at     timestamptz not null,
  used_at        timestamptz,
  host_id        text
);

create index if not exists runner_enrollments_expiry_idx
  on runner_enrollments (expires_at) where used_at is null;

create table if not exists runner_hosts (
  id              text primary key,
  name            text not null,
  owner           text,
  tenant          text not null default 'default',
  platform        text not null check (platform in ('linux', 'windows', 'macos')),
  arch            text not null default 'unknown',
  pool            text not null default 'default',
  labels          jsonb not null default '{}'::jsonb,
  max_concurrent  integer not null default 1,
  agent_version   text,
  status          text not null default 'pending'
                  check (status in ('pending', 'provisioning', 'initializing', 'ready',
                                    'not_ready', 'unreachable', 'maintenance', 'deleting',
                                    'error')),
  drain           boolean not null default false,
  last_heartbeat  timestamptz,
  enrolled_at     timestamptz not null default now(),
  token_hash      text not null,
  cert_fingerprint text,
  metrics         jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create unique index if not exists runner_hosts_name_idx on runner_hosts (name);
create index if not exists runner_hosts_schedulable_idx
  on runner_hosts (platform, pool, status, drain);

create table if not exists runner_leases (
  id             text primary key,
  host_id        text not null references runner_hosts(id) on delete cascade,
  run_id         text not null,
  runner_id      text not null,
  state          text not null default 'active'
                 check (state in ('active', 'released', 'expired', 'error')),
  created_at     timestamptz not null default now(),
  expires_at     timestamptz not null,
  last_heartbeat timestamptz not null default now(),
  unique (runner_id)
);

create index if not exists runner_leases_host_state_idx
  on runner_leases (host_id, state);
create index if not exists runner_leases_expiry_idx
  on runner_leases (expires_at) where state = 'active';

create table if not exists runner_commands (
  id           text primary key,
  host_id      text not null references runner_hosts(id) on delete cascade,
  type         text not null,
  payload      jsonb not null default '{}'::jsonb,
  status       text not null default 'pending'
               check (status in ('pending', 'claimed', 'done', 'error', 'expired')),
  created_at   timestamptz not null default now(),
  claimed_at   timestamptz,
  completed_at timestamptz,
  result       jsonb,
  error        text
);

create index if not exists runner_commands_host_status_idx
  on runner_commands (host_id, status, created_at);
create index if not exists runner_commands_pending_idx
  on runner_commands (host_id, created_at) where status = 'pending';

create table if not exists runner_metrics (
  id                 bigserial primary key,
  host_id            text not null references runner_hosts(id) on delete cascade,
  captured_at        timestamptz not null,
  cpu_percent        real,
  memory_used_percent real,
  disk_used_percent  real,
  metrics            jsonb not null default '{}'::jsonb
);

create index if not exists runner_metrics_host_time_idx
  on runner_metrics (host_id, captured_at desc);

create table if not exists runner_alert_rules (
  id               text primary key,
  scope            text not null default 'global'
                   check (scope in ('global', 'pool', 'host')),
  host_id          text references runner_hosts(id) on delete cascade,
  pool             text,
  metric           text not null,
  comparison       text not null check (comparison in ('gt', 'lt')),
  threshold        real not null,
  duration_seconds integer not null default 0,
  severity         text not null default 'warning'
                   check (severity in ('warning', 'critical')),
  channel          text not null default 'inbox',
  enabled          boolean not null default true,
  created_at       timestamptz not null default now()
);

create index if not exists runner_alert_rules_enabled_idx
  on runner_alert_rules (enabled, metric);

create table if not exists runner_alerts (
  id               text primary key,
  host_id          text not null references runner_hosts(id) on delete cascade,
  rule_id          text not null,
  metric           text not null,
  severity         text not null check (severity in ('warning', 'critical')),
  state            text not null default 'firing'
                   check (state in ('firing', 'acknowledged', 'resolved', 'silenced')),
  value            real,
  message          text not null,
  dedupe_key       text not null,
  first_seen       timestamptz not null default now(),
  last_seen        timestamptz not null default now(),
  acknowledged_at  timestamptz,
  acknowledged_by  text,
  silenced_until   timestamptz,
  resolved_at      timestamptz
);

-- One active alert per (host, rule). Resolved rows remain for history.
create unique index if not exists runner_alerts_active_idx
  on runner_alerts (dedupe_key) where resolved_at is null;

create index if not exists runner_alerts_host_state_idx
  on runner_alerts (host_id, state, last_seen desc);
create index if not exists runner_alerts_state_idx
  on runner_alerts (state, last_seen desc);

-- Default rules (spec `runner-observability`). They are editable through the API.
insert into runner_alert_rules
  (id, scope, metric, comparison, threshold, duration_seconds, severity, channel)
values
  ('cpu-warning', 'global', 'cpu_percent', 'gt', 85, 300, 'warning', 'inbox'),
  ('cpu-critical', 'global', 'cpu_percent', 'gt', 95, 120, 'critical', 'inbox'),
  ('memory-warning', 'global', 'memory_used_percent', 'gt', 85, 300, 'warning', 'inbox'),
  ('memory-critical', 'global', 'memory_used_percent', 'gt', 95, 120, 'critical', 'inbox'),
  ('disk-warning', 'global', 'disk_used_percent', 'gt', 80, 0, 'warning', 'inbox'),
  ('disk-critical', 'global', 'disk_used_percent', 'gt', 90, 0, 'critical', 'inbox'),
  ('disk-free-warning', 'global', 'disk_free_bytes', 'lt', 10737418240, 0, 'warning', 'inbox'),
  ('disk-free-critical', 'global', 'disk_free_bytes', 'lt', 2147483648, 0, 'critical', 'inbox'),
  ('inode-warning', 'global', 'inode_used_percent', 'gt', 90, 0, 'warning', 'inbox'),
  ('heartbeat-warning', 'global', 'heartbeat_age_seconds', 'gt', 60, 0, 'warning', 'inbox'),
  ('heartbeat-critical', 'global', 'heartbeat_age_seconds', 'gt', 150, 0, 'critical', 'inbox'),
  ('queue-wait-warning', 'global', 'queue_wait_seconds', 'gt', 600, 0, 'warning', 'inbox')
on conflict (id) do nothing;
