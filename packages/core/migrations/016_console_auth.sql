-- Console auth (change `add-console-auth`).
--
-- Real identities for the console and the API: users, opaque sessions and per-user scope.
--
--   * `users.password_hash` is an argon2id hash (Bun.password); never a plain value.
--   * `sessions.token_hash` is the SHA-256 hex of the opaque token; the token itself is
--     only ever held by the browser (HttpOnly `factory_session` cookie), so a database
--     leak does not hand out live sessions.
--   * `created_by` is the owner of a work item / chat run. Null means "pre-auth row":
--     admins see it, members do not (design decision 4). Stage runs inherit their work
--     item's owner, so their `created_by` stays null.

create table if not exists users (
  id            uuid primary key default gen_random_uuid(),
  email         text not null unique,
  -- Slug used for the forge identity and the personal org (`u-<username>`).
  username      text not null unique
                check (username ~ '^[a-z0-9][a-z0-9_-]{1,38}$'),
  name          text,
  password_hash text not null,
  role          text not null default 'member' check (role in ('admin', 'member')),
  disabled      boolean not null default false,
  -- Personal forge organization provisioned on first login (best effort).
  forge_org     text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table if not exists sessions (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references users(id) on delete cascade,
  token_hash   text not null unique,
  expires_at   timestamptz not null,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create index if not exists sessions_user_idx on sessions (user_id);
create index if not exists sessions_expires_idx on sessions (expires_at);

-- Owner of a work item; the run list joins through this column for stage runs.
alter table work_items
  add column if not exists created_by uuid references users(id) on delete set null;

create index if not exists work_items_created_by_idx on work_items (created_by);

-- Owner of a chat run. Factory stage runs are owned by their work item and stay null.
alter table runs
  add column if not exists created_by uuid references users(id) on delete set null;

create index if not exists runs_created_by_idx on runs (created_by);
