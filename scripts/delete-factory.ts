#!/usr/bin/env bun
/**
 * Delete a factory: pause its automations, purge its read-model rows, remove its directory.
 *
 *   bun scripts/delete-factory.ts <name> --yes [--force] [--keep-db]
 *
 * Factory definitions are git-backed (ADR-003), so removal is a repository change plus a
 * read-model cleanup. The script refuses to delete a factory with active work items or live
 * runs unless `--force` is given. It never prints credentials.
 */

import { SQL } from 'bun';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const argv = process.argv.slice(2);
const factory = argv[0];
const yes = argv.includes('--yes');
const force = argv.includes('--force');
const keepDb = argv.includes('--keep-db');

if (!factory || !/^[a-z0-9][a-z0-9._-]*$/.test(factory)) {
  console.error('usage: bun scripts/delete-factory.ts <factory> --yes [--force] [--keep-db]');
  process.exit(1);
}

const api = (process.env.API_BASE_URL ?? 'http://localhost:8080/api/v1').replace(/\/$/, '');
const factoryRoot = resolve(process.env.FACTORY_ROOT ?? './factories');
const dir = join(factoryRoot, factory);

if (!dir.startsWith(`${factoryRoot}/`)) {
  console.error('refusing to delete outside FACTORY_ROOT');
  process.exit(1);
}

const plan = [
  `factory:   ${factory}`,
  `directory: ${dir}${existsSync(dir) ? '' : ' (missing)'}`,
  `database:  ${keepDb ? 'kept (history)' : 'read-model rows purged'}`,
  `api:       ${api}`,
];

console.log('Delete factory — plan\n');
for (const line of plan) console.log(`  ${line}`);
console.log('\nThis cannot be undone from the console. Git history keeps the definition.');

if (!yes) {
  console.log('\nRe-run with --yes to proceed.');
  process.exit(2);
}

async function get<T>(path: string): Promise<T> {
  const response = await fetch(`${api}${path}`, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`GET ${path} → ${response.status}`);
  return (await response.json()) as T;
}

// 1. Refuse to delete a factory that is still doing work.
try {
  const items = await get<{ workItems?: Array<{ id: string; status: string }> }>(
    `/work-items?factory=${encodeURIComponent(factory)}`,
  );
  const active = (items.workItems ?? []).filter((item) =>
    ['active', 'running', 'pending'].includes(item.status),
  );
  const runs = await get<{ runs?: Array<{ id: string; status: string }> }>(
    `/runs?factory=${encodeURIComponent(factory)}`,
  );
  const live = (runs.runs ?? []).filter((run) => ['pending', 'running'].includes(run.status));
  if ((active.length > 0 || live.length > 0) && !force) {
    console.error(
      `\nrefusing: ${active.length} active item(s), ${live.length} live run(s). Cancel/retry or use --force.`,
    );
    process.exit(3);
  }
} catch (error) {
  console.warn(`\nwarning: could not check live work (${(error as Error).message}); continuing.`);
}

// 2. Pause automations so no new work is dispatched after deletion.
try {
  const automations = await get<{ automations?: Array<{ name: string }> }>(
    `/factories/${encodeURIComponent(factory)}/automations`,
  );
  for (const automation of automations.automations ?? []) {
    const response = await fetch(
      `${api}/factories/${encodeURIComponent(factory)}/automations/${encodeURIComponent(automation.name)}/pause`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ actor: 'delete-factory', reason: 'factory removed' }),
      },
    );
    console.log(`automation ${automation.name}: ${response.status === 200 ? 'paused' : `pause failed (${response.status})`}`);
  }
} catch (error) {
  console.warn(`warning: could not pause automations (${(error as Error).message})`);
}

// 3. Purge read-model rows for this factory (best effort; FKs may need a second pass).
if (!keepDb && process.env.DATABASE_URL) {
  const sql = new SQL(process.env.DATABASE_URL, { max: 1 });
  try {
    const tables = (await sql.unsafe(
      `select table_name from information_schema.columns
       where table_schema = 'public' and column_name = 'factory'
       order by table_name`,
    )) as Array<{ table_name: string }>;
    let deleted = 0;
    for (const { table_name } of tables) {
      if (table_name === 'schema_migrations') continue;
      try {
        const rows = (await sql.unsafe(
          `delete from "${table_name}" where factory = $1 returning 1`,
          [factory],
        )) as unknown[];
        if (rows.length > 0) {
          deleted += rows.length;
          console.log(`db ${table_name}: ${rows.length} row(s) deleted`);
        }
      } catch (error) {
        console.warn(`db ${table_name}: skipped (${(error as Error).message})`);
      }
    }
    console.log(`db: ${deleted} row(s) deleted in total`);
  } finally {
    await sql.close();
  }
} else if (!keepDb) {
  console.warn('warning: DATABASE_URL is unset; read-model rows were not purged.');
}

// 4. Remove the definition directory.
if (existsSync(dir)) {
  await rm(dir, { recursive: true, force: true });
  console.log(`directory removed: ${dir}`);
} else {
  console.log('directory already absent');
}

console.log(`\nDone. Commit the removal:\n  git add -A && git commit -m "chore: remove factory ${factory}"`);
