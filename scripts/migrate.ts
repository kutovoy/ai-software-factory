#!/usr/bin/env bun
/**
 * Idempotent migration runner (task 5.2).
 *
 *   bun scripts/migrate.ts                 # apply everything
 *   DATABASE_URL=postgres://... bun scripts/migrate.ts
 *
 * Every file in `packages/core/migrations` is applied once and recorded in
 * `schema_migrations`; each file is also written with `if not exists`, so re-running from a
 * clean or half-migrated database is safe. A single advisory lock serialises concurrent
 * runners (compose may start api and worker at the same time).
 */
import { SQL } from 'bun';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const MIGRATIONS_DIR = join(import.meta.dir, '..', 'packages', 'core', 'migrations');
const LOCK_KEY = 8_412_001; // arbitrary, stable

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }

  const sql = new SQL(databaseUrl, { max: 1 });
  try {
    await sql`create table if not exists schema_migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    )`;

    const files = (await readdir(MIGRATIONS_DIR))
      .filter((file) => file.endsWith('.sql'))
      .sort();

    if (files.length === 0) {
      console.log('no migrations found');
      return;
    }

    await sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(${LOCK_KEY})`;

      const applied = new Set(
        ((await tx`select name from schema_migrations`) as { name: string }[]).map((row) => row.name),
      );

      for (const file of files) {
        if (applied.has(file)) {
          console.log(`skip   ${file} (already applied)`);
          continue;
        }
        const body = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
        await tx.unsafe(body);
        await tx`insert into schema_migrations (name) values (${file}) on conflict do nothing`;
        console.log(`apply  ${file}`);
      }
    });

    console.log(`migrations up to date (${files.length} file(s))`);
  } finally {
    await sql.close();
  }
}

main().catch((error: unknown) => {
  console.error(`migration failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
