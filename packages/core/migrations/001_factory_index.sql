-- Derived index of factory definitions. Never authoritative: definitions live in git
-- and this schema only mirrors them for querying. Rebuild by re-indexing a commit.

create table if not exists factory_definitions (
  id           uuid primary key default gen_random_uuid(),
  factory      text not null,
  commit_sha   text not null,
  schema_version text not null,
  manifest     jsonb not null,
  content_hash text not null,
  created_at   timestamptz not null default now(),
  unique (factory, commit_sha)
);

create table if not exists factory_versions (
  id           uuid primary key default gen_random_uuid(),
  factory      text not null,
  commit_sha   text not null,
  tag          text,
  content_hash text not null,
  dirty        boolean not null default false,
  created_at   timestamptz not null default now(),
  unique (factory, commit_sha)
);

create table if not exists resources (
  id           uuid primary key default gen_random_uuid(),
  factory      text not null,
  commit_sha   text not null,
  path         text not null,
  kind         text not null,
  name         text not null,
  hash         text not null,
  doc          jsonb not null,
  body         text,
  unique (factory, commit_sha, path)
);

create index if not exists factory_definitions_factory_commit_idx
  on factory_definitions (factory, commit_sha);

create index if not exists resources_factory_commit_idx
  on resources (factory, commit_sha);

create index if not exists resources_factory_kind_name_idx
  on resources (factory, kind, name);
