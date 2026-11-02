-- Factory identity (change `add-factory-identity`, spec `factory-identity`).
--
-- Factories get a stable, unguessable `fac_<ulid>` id committed in `factory.yaml`, plus a
-- registry row that maps that id to an owner, a local name, the definition path and the
-- internal key. The registry is a derived index of git: the definition stays authoritative
-- and a rebuild can recreate every row.
--
--   * `key` is the internal key used by every existing table: the legacy top-level directory
--     name (`example`) or the owner-scoped path (`alice/hello-nextjs`). Two users may own
--     factories with the same local `name`; the key and the path keep them apart.
--   * `owner_id` is the console user that owns the factory. Legacy top-level directories are
--     admin-owned; nested `<owner>/<name>` directories belong to `<owner>`. Null means "no
--     matching user" (a pre-auth deployment) — admins see it, members do not.
--   * `work_items.factory_id` / `runs.factory_id` carry the identity next to the existing
--     `factory` text, which stays the key so every historical query keeps working.

create table if not exists factories (
  id         text primary key,
  owner_id   uuid references users(id) on delete set null,
  name       text not null,
  key        text not null unique,
  path       text not null unique,
  alias      text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, name)
);

create index if not exists factories_owner_idx on factories (owner_id);
create index if not exists factories_name_idx on factories (name);

alter table work_items
  add column if not exists factory_id text;

alter table runs
  add column if not exists factory_id text;

create index if not exists work_items_factory_id_idx on work_items (factory_id);
create index if not exists runs_factory_id_idx on runs (factory_id);
