#!/usr/bin/env bun
/**
 * Factory identity migration (change `add-factory-identity`, spec `factory-identity`).
 *
 *   bun scripts/migrate-factory-identity.ts --dry-run
 *   DATABASE_URL=postgres://... bun scripts/migrate-factory-identity.ts
 *
 * One-shot, idempotent backfill:
 *   1. every definition under `FACTORY_ROOT` without `id` gets a fresh `fac_<ulid>` written
 *      into `factory.yaml` (canonical YAML: sorted keys, two-space indent);
 *   2. the `factories` registry is filled (id → owner, name, path, key): legacy top-level
 *      directories are admin-owned, `<owner>/<name>` directories belong to `<owner>`;
 *   3. `work_items.factory_id` and `runs.factory_id` are backfilled by joining on the
 *      internal key (`factory` text), so no row is deleted or rewritten otherwise.
 *
 * `hello-nextjs` and every other existing row is kept — the change adds identity, it does
 * not purge history.
 */
import { SQL } from 'bun';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  canonicalYaml,
  loadDefinition,
  newFactoryId,
  type FactoryManifest,
} from '../packages/core/src/index';

const FACTORY_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;
const DRY_RUN = process.argv.includes('--dry-run');
const FACTORY_ROOT = resolve(process.env.FACTORY_ROOT ?? 'factories');

interface FoundFactory {
  key: string;
  path: string;
  name: string;
  dir: string;
  legacy: boolean;
  ownerUsername: string | null;
}

function scan(): FoundFactory[] {
  if (!existsSync(FACTORY_ROOT)) return [];

  const found: FoundFactory[] = [];
  for (const entry of readdirSync(FACTORY_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || !FACTORY_NAME_RE.test(entry.name)) {
      continue;
    }
    const dir = join(FACTORY_ROOT, entry.name);
    if (existsSync(join(dir, 'factory.yaml'))) {
      found.push({
        key: entry.name,
        path: entry.name,
        name: entry.name,
        dir,
        legacy: true,
        ownerUsername: null,
      });
      continue;
    }
    for (const child of readdirSync(dir, { withFileTypes: true })) {
      if (!child.isDirectory() || !FACTORY_NAME_RE.test(child.name)) continue;
      const childDir = join(dir, child.name);
      if (!existsSync(join(childDir, 'factory.yaml'))) continue;
      found.push({
        key: `${entry.name}/${child.name}`,
        path: `${entry.name}/${child.name}`,
        name: child.name,
        dir: childDir,
        legacy: false,
        ownerUsername: entry.name,
      });
    }
  }
  return found.sort((left, right) => left.key.localeCompare(right.key));
}

/** Adds `id` to `factory.yaml` (canonical YAML) when it is missing. Returns the id. */
function ensureId(factory: FoundFactory): { id: string; minted: boolean } {
  const { definition, errors } = loadDefinition(factory.dir);
  if (!definition) {
    throw new Error(
      `factory "${factory.key}" does not validate:\n${errors
        .map((error) => `  ${error.code} ${error.file} ${error.pointer}: ${error.message}`)
        .join('\n')}`,
    );
  }

  if (definition.manifest.id) return { id: definition.manifest.id, minted: false };

  const id = newFactoryId();
  const manifest: FactoryManifest = { ...definition.manifest, id };
  if (!DRY_RUN) {
    writeFileSync(join(factory.dir, 'factory.yaml'), canonicalYaml(manifest), 'utf8');
  }
  return { id, minted: true };
}

async function main(): Promise<void> {
  const factories = scan();
  if (factories.length === 0) {
    console.log(`no factories under ${FACTORY_ROOT}`);
    return;
  }

  const rows = factories.map((factory) => ({ factory, ...ensureId(factory) }));
  for (const row of rows) {
    console.log(
      `${row.minted ? 'mint ' : 'keep '} ${row.factory.key} -> ${row.id}${DRY_RUN ? ' (dry run)' : ''}`,
    );
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.log('DATABASE_URL is not set: registry and factory_id backfill skipped');
    return;
  }

  const sql = new SQL(databaseUrl, { max: 1 });
  try {
    const users = (await sql`
      select id::text as id, username, role from users order by created_at asc
    `) as { id: string; username: string; role: string }[];
    const admin = users.find((user) => user.role === 'admin') ?? null;
    const byUsername = new Map(users.map((user) => [user.username, user]));

    if (DRY_RUN) {
      console.log(`registry: ${rows.length} row(s) would be upserted`);
      let items = 0;
      let runs = 0;
      for (const row of rows) {
        const itemRows = (await sql`
          select count(*)::int as count from work_items where factory = ${row.factory.key}
        `) as { count: number }[];
        const runRows = (await sql`
          select count(*)::int as count from runs where factory = ${row.factory.key}
        `) as { count: number }[];
        items += itemRows[0]?.count ?? 0;
        runs += runRows[0]?.count ?? 0;
      }
      console.log(`backfill: ${items} work item(s), ${runs} run(s)`);
      return;
    }

    for (const row of rows) {
      const owner = row.factory.legacy
        ? admin
        : row.factory.ownerUsername
          ? (byUsername.get(row.factory.ownerUsername) ?? null)
          : null;
      const alias = loadDefinition(row.factory.dir).definition?.manifest.alias ?? null;

      await sql`
        delete from factories
        where (key = ${row.factory.key} or path = ${row.factory.path}) and id <> ${row.id}
      `;
      await sql`
        insert into factories (id, owner_id, name, key, path, alias)
        values (
          ${row.id}, ${owner?.id ?? null}::uuid, ${row.factory.name}, ${row.factory.key},
          ${row.factory.path}, ${alias}
        )
        on conflict (id) do update set
          owner_id = excluded.owner_id,
          name = excluded.name,
          key = excluded.key,
          path = excluded.path,
          alias = excluded.alias,
          updated_at = now()
      `;

      const items = (await sql`
        update work_items set factory_id = ${row.id}
        where factory = ${row.factory.key} and factory_id is distinct from ${row.id}
        returning id
      `) as { id: string }[];
      const runs = (await sql`
        update runs set factory_id = ${row.id}
        where factory = ${row.factory.key} and factory_id is distinct from ${row.id}
        returning id
      `) as { id: string }[];
      console.log(
        `sync   ${row.factory.key}: registry 1, work_items ${items.length}, runs ${runs.length}`,
      );
    }
  } finally {
    await sql.close();
  }
}

main().catch((error: unknown) => {
  console.error(`factory identity migration failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
