-- Progressive context / MCP capability index (roadmap item 9).
--
-- Discovered tool metadata is persisted per factory/server/tool. The definition stays the
-- source of truth for server declarations; this table only indexes what a probe learned so
-- the console can select/promote capabilities without re-reading a schema on every run.

create table if not exists mcp_tools (
  factory       text not null,
  server        text not null,
  tool          text not null,
  description   text,
  schema        jsonb not null default '{}'::jsonb,
  schema_bytes  integer not null default 0,
  status        text not null default 'discovered'
                check (status in ('discovered', 'promoted')),
  discovered_at timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  primary key (factory, server, tool)
);

create index if not exists mcp_tools_factory_idx on mcp_tools (factory, status, server);
