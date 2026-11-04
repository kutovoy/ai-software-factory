-- Registry read model (performance plan, `docs/PERFORMANCE.md`).
--
-- The `factories` table was only a mapping from id -> owner/name/key/path, so every
-- factory-scoped request re-scanned the filesystem and ran git to build version metadata.
-- These columns let `/factories` and `resolveFactory` answer from one indexed query.
--
-- The registry remains derived from git: `syncFactoryRegistry` is the only writer and can
-- rebuild every column from the definitions on disk. Null version columns mean "not yet
-- synced" or "not inside a git repository".

alter table factories
  add column if not exists manifest_name text,
  add column if not exists description text,
  add column if not exists definition_commit text,
  add column if not exists content_hash text,
  add column if not exists dirty boolean,
  add column if not exists tag text,
  add column if not exists resource_count integer,
  add column if not exists repo_count integer,
  add column if not exists valid boolean,
  add column if not exists error_count integer,
  add column if not exists synced_at timestamptz;

create index if not exists factories_synced_at_idx on factories (synced_at);
