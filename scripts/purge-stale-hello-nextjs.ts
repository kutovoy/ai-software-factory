#!/usr/bin/env bun
/**
 * One-off purge of stale `hello-nextjs` read-model rows (change `fix-factory-purge`,
 * task 1.7).
 *
 * The old `delete-factory` script skipped the database when `DATABASE_URL` was unset, so
 * the recreated `hello-nextjs` factory still shows work items and runs from before its
 * removal. This helper removes those stale rows **without touching the PR #4 readiness
 * rows** pinned to definition commit `e67bd6f7f28e93babc694d1f0b73fd99364aeaa5`.
 *
 *   DATABASE_URL=postgres://factory:factory@localhost:5433/factory \
 *   bun scripts/purge-stale-hello-nextjs.ts --dry-run
 *
 *   DATABASE_URL=... RUNS_DIR=runs bun scripts/purge-stale-hello-nextjs.ts
 *
 * It deletes only rows whose `definition_commit` differs from the keep commit (plus the
 * rows that reference those runs/work items and their `runs/<id>/` directories). The
 * factory definition, its registry row, autonomy/integration settings, git history and
 * the forge repository/PRs stay untouched. Idempotent: a second run finds nothing.
 */

import { SQL } from 'bun';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const FACTORY = process.env.PURGE_FACTORY ?? 'hello-nextjs';
const KEEP_COMMIT =
  process.env.KEEP_DEFINITION_COMMIT ?? 'e67bd6f7f28e93babc694d1f0b73fd99364aeaa5';
const DRY_RUN = process.argv.includes('--dry-run');
const RUNS_DIR = resolve(process.env.RUNS_DIR ?? 'runs');
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error(
    'error: DATABASE_URL is unset. This one-off helper needs the database it is cleaning:\n' +
      '  DATABASE_URL=postgres://factory:factory@localhost:5433/factory bun scripts/purge-stale-hello-nextjs.ts',
  );
  process.exit(1);
}

const sql = new SQL(DATABASE_URL, { max: 1 });

interface IdRow {
  id: string;
}

function csv(ids: string[]): string {
  return ids.join(',');
}

async function main(): Promise<void> {
  const staleRuns = (await sql`
    select id from runs
    where factory = ${FACTORY} and definition_commit <> ${KEEP_COMMIT}
    order by started_at
  `) as IdRow[];
  const staleItems = (await sql`
    select id from work_items
    where factory = ${FACTORY} and definition_commit <> ${KEEP_COMMIT}
    order by created_at
  `) as IdRow[];
  const keptItems = (await sql`
    select id, definition_commit, pr_url, pr_number from work_items
    where factory = ${FACTORY} and definition_commit = ${KEEP_COMMIT}
  `) as Array<{ id: string; pr_url: string | null; pr_number: number | null }>;
  const keptRuns = (await sql`
    select count(*)::int as count from runs
    where factory = ${FACTORY} and definition_commit = ${KEEP_COMMIT}
  `) as Array<{ count: number }>;

  const runIds = staleRuns.map((row) => row.id);
  const itemIds = staleItems.map((row) => row.id);
  const runDirs = runIds.map((id) => join(RUNS_DIR, id)).filter((dir) => existsSync(dir));

  console.log(`Stale purge for "${FACTORY}" (keeping definition commit ${KEEP_COMMIT.slice(0, 8)})\n`);
  console.log(`  stale work items: ${itemIds.length}`);
  console.log(`  stale runs:       ${runIds.length}`);
  console.log(`  stale run dirs:   ${runDirs.length}`);
  console.log(`  kept work items:  ${keptItems.length}`);
  console.log(`  kept runs:        ${keptRuns[0]?.count ?? 0}`);
  for (const item of keptItems) {
    console.log(`    keep ${item.id}  PR ${item.pr_number ?? '-'}  ${item.pr_url ?? ''}`);
  }

  if (DRY_RUN) {
    console.log('\nDry run: nothing was deleted.');
    return;
  }

  if (runIds.length === 0 && itemIds.length === 0) {
    console.log('\nNothing stale remains; the database is already clean.');
    return;
  }

  const deleted = await sql.begin(async (tx) => {
    const counts: Record<string, number> = {};
    const count = (name: string, rows: unknown[]) => {
      counts[name] = (counts[name] ?? 0) + rows.length;
    };

    // Benchmark rows pinned to a stale definition commit (trials/results/events cascade).
    count(
      'benchmark_attestations',
      (await tx`
        delete from benchmark_attestations
        where factory = ${FACTORY} and definition_commit <> ${KEEP_COMMIT}
        returning 1
      `) as unknown[],
    );
    count(
      'benchmark_runs',
      (await tx`
        delete from benchmark_runs
        where factory = ${FACTORY} and definition_commit <> ${KEEP_COMMIT}
        returning 1
      `) as unknown[],
    );

    // References held by tables without an FK to the parents.
    if (runIds.length > 0) {
      const runCsv = csv(runIds);
      count(
        'score_runs',
        (await tx.unsafe(
          `delete from score_runs
           where factory = $1 and run_id = any(string_to_array($2, ','))
           returning 1`,
          [FACTORY, runCsv],
        )) as unknown[],
      );
      count(
        'run_secrets',
        (await tx.unsafe(
          `delete from run_secrets
           where run_id = any(string_to_array($1, ','))
           returning 1`,
          [runCsv],
        )) as unknown[],
      );
      count(
        'benchmark_trials',
        (await tx.unsafe(
          `delete from benchmark_trials
           where factory = $1 and run_id = any(string_to_array($2, ','))
           returning 1`,
          [FACTORY, runCsv],
        )) as unknown[],
      );
    }

    if (itemIds.length > 0) {
      const itemCsv = csv(itemIds);
      count(
        'score_runs',
        (await tx.unsafe(
          `delete from score_runs
           where factory = $1 and work_item_id = any(string_to_array($2, ','))
           returning 1`,
          [FACTORY, itemCsv],
        )) as unknown[],
      );
      count(
        'merge_batch_items',
        (await tx.unsafe(
          `delete from merge_batch_items
           where factory = $1 and work_item_id = any(string_to_array($2, ','))
           returning 1`,
          [FACTORY, itemCsv],
        )) as unknown[],
      );
      count(
        'webhook_deliveries',
        (await tx.unsafe(
          `delete from webhook_deliveries
           where factory = $1 and work_item_id = any(string_to_array($2, ','))
           returning 1`,
          [FACTORY, itemCsv],
        )) as unknown[],
      );
      count(
        'automation_fires',
        (await tx.unsafe(
          `delete from automation_fires
           where factory = $1 and work_item_id = any(string_to_array($2, ','))
           returning 1`,
          [FACTORY, itemCsv],
        )) as unknown[],
      );
    }

    // Parents last: their child rows cascade (events, steps, gates, scores, ...).
    if (runIds.length > 0) {
      count(
        'runs',
        (await tx.unsafe(
          `delete from runs where id = any(string_to_array($1, ',')) returning 1`,
          [csv(runIds)],
        )) as unknown[],
      );
    }
    if (itemIds.length > 0) {
      count(
        'work_items',
        (await tx.unsafe(
          `delete from work_items where id = any(string_to_array($1, ',')) returning 1`,
          [csv(itemIds)],
        )) as unknown[],
      );
    }

    // Verify: no stale rows left, the kept rows and their PR link are intact.
    const staleRunsLeft = (await tx`
      select count(*)::int as count from runs
      where factory = ${FACTORY} and definition_commit <> ${KEEP_COMMIT}
    `) as Array<{ count: number }>;
    const staleItemsLeft = (await tx`
      select count(*)::int as count from work_items
      where factory = ${FACTORY} and definition_commit <> ${KEEP_COMMIT}
    `) as Array<{ count: number }>;
    if (Number(staleRunsLeft[0]?.count ?? 0) !== 0 || Number(staleItemsLeft[0]?.count ?? 0) !== 0) {
      throw new Error('verification failed: stale rows survived the purge');
    }

    return counts;
  });

  for (const [table, rows] of Object.entries(deleted)) {
    if (rows > 0) console.log(`  deleted ${table}: ${rows}`);
  }
  console.log(`  deleted total: ${Object.values(deleted).reduce((sum, n) => sum + n, 0)}`);

  let removed = 0;
  for (const dir of runDirs) {
    await rm(dir, { recursive: true, force: true });
    removed += 1;
  }
  console.log(`  removed run dirs: ${removed}`);

  console.log('\nDone. The kept PR #4 rows and the definition/forge repository were not touched.');
}

try {
  await main();
} finally {
  await sql.close();
}
