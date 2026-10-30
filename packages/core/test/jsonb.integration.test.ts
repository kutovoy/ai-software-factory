import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { SQL } from 'bun';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createWorkItem, getWorkItem } from '../src/index';

/**
 * jsonb hygiene (harden-runtime, task 4.3).
 *
 * Opt-in (needs Postgres):
 *
 *   DATABASE_URL=postgres://factory:factory@localhost:5433/factory \
 *   RUN_INTEGRATION=1 bun test packages/core/test/jsonb.integration.test.ts
 *
 * Covers the repository boundary (one encode) and the `011_jsonb_normalise.sql` rewrite of
 * legacy double-encoded rows, including `->>` queries.
 */

const enabled = process.env.RUN_INTEGRATION === '1' && Boolean(process.env.DATABASE_URL);
const suite = enabled ? describe : describe.skip;

const MIGRATIONS = join(import.meta.dir, '..', 'migrations');
const FACTORY = 'itest-jsonb';
const WORK_ITEM_ID = 'wi_01M66J5NBTE5T000000000000A';

let sql: SQL;

async function migrate(databaseUrl: string): Promise<void> {
  const client = new SQL(databaseUrl, { max: 1 });
  try {
    await client`create table if not exists schema_migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    )`;
    const applied = new Set(
      ((await client`select name from schema_migrations`) as { name: string }[]).map(
        (row) => row.name,
      ),
    );
    const files = (await readdir(MIGRATIONS)).filter((file) => file.endsWith('.sql')).sort();
    for (const file of files) {
      if (applied.has(file)) continue;
      await client.unsafe(await readFile(join(MIGRATIONS, file), 'utf8'));
      await client`insert into schema_migrations (name) values (${file}) on conflict do nothing`;
    }
  } finally {
    await client.close();
  }
}

async function normaliseJsonb(): Promise<void> {
  await sql.unsafe(await readFile(join(MIGRATIONS, '011_jsonb_normalise.sql'), 'utf8'));
}

suite('jsonb hygiene', () => {
  beforeAll(async () => {
    await migrate(process.env.DATABASE_URL as string);
    sql = new SQL(process.env.DATABASE_URL as string, { max: 2 });
    await sql`delete from work_items where id = ${WORK_ITEM_ID}`;
    await sql`delete from work_items where factory = ${FACTORY}`;
  }, 60_000);

  afterAll(async () => {
    await sql`delete from work_items where factory = ${FACTORY}`.catch(() => undefined);
    await sql.close();
  }, 30_000);

  test('the repository encodes an object exactly once and -> > reads it', async () => {
    const sourceRef = { kind: 'issue', id: '123', nested: { labels: ['bug', 'api'] } };
    const input = { stageGraph: ['triage', 'spec'], gates: { spec: 'human' } };
    const item = await createWorkItem(sql, {
      id: WORK_ITEM_ID,
      factory: FACTORY,
      type: 'task',
      source: 'forge',
      sourceRef,
      title: 'jsonb round-trip',
      stage: 'triage',
      definitionCommit: 'c8fcb7e1',
      input,
    });

    expect(item.sourceRef).toEqual(sourceRef);

    const rows = (await sql`
      select jsonb_typeof(source_ref) as sr_type, source_ref->>'kind' as kind,
             jsonb_typeof(input) as input_type, input->'gates'->>'spec' as spec_gate
      from work_items where id = ${WORK_ITEM_ID}
    `) as {
      sr_type: string;
      kind: string | null;
      input_type: string;
      spec_gate: string | null;
    }[];
    expect(rows[0]?.sr_type).toBe('object');
    expect(rows[0]?.kind).toBe('issue');
    expect(rows[0]?.input_type).toBe('object');
    expect(rows[0]?.spec_gate).toBe('human');

    // A read through the repository returns the same object (no parseJsonb double-unwrap).
    const read = await getWorkItem(sql, WORK_ITEM_ID);
    expect(read?.sourceRef).toEqual(sourceRef);
  }, 60_000);

  test('the migration normalises a legacy double-encoded row', async () => {
    const legacy = { kind: 'schedule', scheduleId: 'example:intake', cron: '0 3 * * *' };
    await sql`
      insert into work_items (
        id, factory, type, source, source_ref, title, stage, status, definition_commit, input
      ) values (
        'wi_01M66J5NBTE5T000000000000B', ${FACTORY}, 'task', 'cron',
        ${JSON.stringify(legacy)}::jsonb, 'legacy jsonb', 'triage', 'active', 'c8fcb7e1',
        ${JSON.stringify({ stageGraph: ['triage'] })}::jsonb
      )
    `;

    const before = (await sql`
      select jsonb_typeof(source_ref) as sr_type from work_items
      where id = 'wi_01M66J5NBTE5T000000000000B'
    `) as { sr_type: string }[];
    expect(before[0]?.sr_type).toBe('string');

    await normaliseJsonb();

    const after = (await sql`
      select jsonb_typeof(source_ref) as sr_type, source_ref->>'kind' as kind,
             jsonb_typeof(input) as input_type, input->'stageGraph'->>0 as first_stage
      from work_items where id = 'wi_01M66J5NBTE5T000000000000B'
    `) as {
      sr_type: string;
      kind: string | null;
      input_type: string;
      first_stage: string | null;
    }[];
    expect(after[0]?.sr_type).toBe('object');
    expect(after[0]?.kind).toBe('schedule');
    expect(after[0]?.input_type).toBe('object');
    expect(after[0]?.first_stage).toBe('triage');

    const read = await getWorkItem(sql, 'wi_01M66J5NBTE5T000000000000B');
    expect(read?.sourceRef).toEqual(legacy);
  }, 60_000);

  test('a plain string value is left alone by the migration', async () => {
    await sql`
      insert into work_items (
        id, factory, type, source, source_ref, title, stage, status, definition_commit, input
      ) values (
        'wi_01M66J5NBTE5T000000000000C', ${FACTORY}, 'task', 'manual',
        ${JSON.stringify('not-an-object')}::jsonb, 'plain string', 'triage', 'active',
        'c8fcb7e1', ${{}}::jsonb
      )
    `;
    await normaliseJsonb();
    const rows = (await sql`
      select jsonb_typeof(source_ref) as sr_type, source_ref #>> '{}' as value
      from work_items where id = 'wi_01M66J5NBTE5T000000000000C'
    `) as { sr_type: string; value: string | null }[];
    expect(rows[0]?.sr_type).toBe('string');
    expect(rows[0]?.value).toContain('not-an-object');
  }, 60_000);
});
