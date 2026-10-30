import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { SQL } from 'bun';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createCanaryRollout,
  createProposal,
  getCanaryRollout,
  listCanaryEvents,
  recordScore,
  updateCanaryRollout,
} from '@factory/core';
import {
  collectCanaryTrees,
  getSql,
  readCanarySeries,
  setSql,
} from '../src/index';

/**
 * Canary follow-ups (harden-runtime, task 5.5): candidate-tree GC and the hourly series.
 *
 * Opt-in (needs Postgres; no Temporal):
 *
 *   DATABASE_URL=postgres://factory:factory@localhost:5433/factory \
 *   RUN_INTEGRATION=1 bun test packages/orchestration/test/canary-followups.integration.test.ts
 */

const enabled = process.env.RUN_INTEGRATION === '1' && Boolean(process.env.DATABASE_URL);
const suite = enabled ? describe : describe.skip;

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');
const MIGRATIONS = join(REPO_ROOT, 'packages', 'core', 'migrations');
const RUNS_DIR = join(REPO_ROOT, 'runs', 'itest-canary-followups');
const FACTORY_GC = 'itest-canary-gc';
const FACTORY_SERIES = 'itest-canary-series';

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

async function rollout(
  id: string,
  status: 'promoted' | 'rolled_back' | 'active',
  startedAt: string,
  endedAt: string | null,
): Promise<string> {
  const proposalId = `prop_${id}`;
  await createProposal(sql, {
    id: proposalId,
    factory: FACTORY_GC,
    authority: 'canary',
    status: status === 'active' ? 'canary' : 'merged',
    title: `GC fixture ${id}`,
    impact: 1,
    candidateHash: id,
  });
  const candidateRoot = join(RUNS_DIR, 'canary', id, 'definition');
  mkdirSync(candidateRoot, { recursive: true });
  writeFileSync(join(candidateRoot, 'factory.yaml'), 'name: itest-canary-gc\n', 'utf8');
  await createCanaryRollout(sql, {
    id,
    factory: FACTORY_GC,
    proposalId,
    candidateVersion: `factory-v${id.length}-candidate`,
    stableVersion: 'factory-v1',
    candidateRoot,
    canaryPercent: 10,
    rollbackThreshold: 0.1,
    observationWindowHours: 24,
    status,
  });
  await sql`
    update canary_rollouts set started_at = ${startedAt}::timestamptz,
      ended_at = ${endedAt}::timestamptz
    where id = ${id}
  `;
  return candidateRoot;
}

suite('canary follow-ups', () => {
  beforeAll(async () => {
    process.env.RUNS_DIR = RUNS_DIR;
    await migrate(process.env.DATABASE_URL as string);
    setSql(new SQL(process.env.DATABASE_URL as string, { max: 4 }));
    sql = getSql();
    await sql`delete from canary_rollouts where factory = ${FACTORY_GC}`;
    await sql`delete from proposals where factory = ${FACTORY_GC}`;
    await sql`delete from runs where factory = ${FACTORY_SERIES}`;
    await sql`delete from scores where factory = ${FACTORY_SERIES}`;
  }, 60_000);

  afterAll(async () => {
    await sql`delete from canary_rollouts where factory = ${FACTORY_GC}`.catch(() => undefined);
    await sql`delete from proposals where factory = ${FACTORY_GC}`.catch(() => undefined);
    await sql`delete from scores where factory = ${FACTORY_SERIES}`.catch(() => undefined);
    await sql`delete from runs where factory = ${FACTORY_SERIES}`.catch(() => undefined);
    rmSync(join(RUNS_DIR, 'canary'), { recursive: true, force: true });
  }, 60_000);

  test('GC keeps the newest N terminal trees and never removes an active tree', async () => {
    const now = Date.now();
    const hour = 60 * 60 * 1000;
    const roots = {
      old1: await rollout('gc_old1', 'rolled_back', new Date(now - 4 * hour).toISOString(), new Date(now - 3 * hour).toISOString()),
      old2: await rollout('gc_old2', 'promoted', new Date(now - 3 * hour).toISOString(), new Date(now - 2 * hour).toISOString()),
      new1: await rollout('gc_new1', 'promoted', new Date(now - 2 * hour).toISOString(), new Date(now - 1 * hour).toISOString()),
      new2: await rollout('gc_new2', 'rolled_back', new Date(now - 1 * hour).toISOString(), new Date(now).toISOString()),
      active: await rollout('gc_active', 'active', new Date(now - 30 * 60 * 1000).toISOString(), null),
    };

    const result = await collectCanaryTrees(sql, {
      factory: FACTORY_GC,
      keep: 2,
      actor: 'itest',
      reason: 'itest prune',
    });

    expect(result.keep).toBe(2);
    expect(result.protected).toEqual(['gc_active']);
    expect(new Set(result.kept)).toEqual(new Set(['gc_new1', 'gc_new2']));
    expect(new Set(result.removed)).toEqual(new Set(['gc_old1', 'gc_old2']));

    expect(existsSync(roots.new1)).toBe(true);
    expect(existsSync(roots.new2)).toBe(true);
    expect(existsSync(roots.active)).toBe(true);
    expect(existsSync(roots.old1)).toBe(false);
    expect(existsSync(roots.old2)).toBe(false);

    // Removals are audited per rollout (deduped by (rollout_id, type, subject)).
    const events = await listCanaryEvents(sql, { rolloutId: 'gc_old1' });
    expect(events.map((event) => event.type)).toContain('canary.gc');
    expect(await getCanaryRollout(sql, 'gc_active')).toBeTruthy();
  }, 60_000);

  test('the hourly series derives pass rate, runs and error rate, with nulls for empty buckets', async () => {
    const hour = 60 * 60 * 1000;
    const now = Math.floor(Date.now() / hour) * hour;
    const stable = 'stable_commit_series';
    const candidate = 'candidate_commit_series';
    const from = new Date(now - 3 * hour).toISOString();

    const insertRun = async (
      id: string,
      commit: string,
      startedAt: string,
      status: string,
    ): Promise<void> => {
      await sql`
        insert into runs (
          id, factory, definition_commit, definition_dirty, harness, model, runner, kind,
          title, input, status, workflow_id, started_at, ended_at
        ) values (
          ${id}, ${FACTORY_SERIES}, ${commit}, false, 'fake', null, 'fake', 'run',
          null, ${{}}::jsonb, ${status}, ${`run-${id}`}, ${startedAt}::timestamptz,
          ${startedAt}::timestamptz
        )
      `;
    };

    // Stable: two scored runs in one bucket (one failed), one unscored run in another.
    await insertRun('run_series_s1', stable, new Date(now - 2 * hour).toISOString(), 'ok');
    await insertRun('run_series_s2', stable, new Date(now - 2 * hour + 60_000).toISOString(), 'error');
    await insertRun('run_series_s3', stable, new Date(now - hour).toISOString(), 'ok');
    // Candidate: one scored run in its own bucket.
    await insertRun('run_series_c1', candidate, new Date(now - 2 * hour).toISOString(), 'ok');

    for (const [index, runId] of ['run_series_s1', 'run_series_s2'].entries()) {
      await recordScore(sql, {
        id: `score_series_s${index}`,
        factory: FACTORY_SERIES,
        runId,
        scorer: 'scope',
        scorerClass: 'deterministic',
        rubricHash: 'rubric_series',
        status: 'ok',
        score: index === 1 ? 0 : 1,
        passing: index !== 1,
      });
    }
    await recordScore(sql, {
      id: 'score_series_c1',
      factory: FACTORY_SERIES,
      runId: 'run_series_c1',
      scorer: 'scope',
      scorerClass: 'deterministic',
      rubricHash: 'rubric_series',
      status: 'ok',
      score: 1,
      passing: true,
    });

    const series = await readCanarySeries({
      factory: FACTORY_SERIES,
      rolloutId: 'series_itest',
      stableCommit: stable,
      candidateCommit: candidate,
      startedAt: from,
      until: new Date(now).toISOString(),
    });

    expect(series.bucketHours).toBe(1);
    expect(series.stable).toHaveLength(4);
    expect(series.candidate).toHaveLength(4);

    // Buckets: [now-3h, now-2h, now-1h, now]; the scored runs sit in the second bucket.
    const scoredStable = series.stable[1];
    expect(scoredStable?.runs).toBe(2);
    expect(scoredStable?.failedRuns).toBe(1);
    expect(scoredStable?.passRate).toBe(0.5);
    expect(scoredStable?.errorRate).toBe(0.5);
    expect(scoredStable?.reason).toBeNull();

    const unscoredStable = series.stable[2];
    expect(unscoredStable?.runs).toBe(1);
    expect(unscoredStable?.scores).toBe(0);
    expect(unscoredStable?.passRate).toBeNull();
    expect(unscoredStable?.reason).toBe('no_scores_in_bucket');

    const scoredCandidate = series.candidate[1];
    expect(scoredCandidate?.runs).toBe(1);
    expect(scoredCandidate?.passRate).toBe(1);
    expect(scoredCandidate?.errorRate).toBe(0);

    // Empty buckets are null + reason, never zero.
    const emptyStable = series.stable[0];
    expect(emptyStable?.runs).toBe(0);
    expect(emptyStable?.passRate).toBeNull();
    expect(emptyStable?.errorRate).toBeNull();
    expect(emptyStable?.reason).toBe('no_runs_in_bucket');

    const emptyCandidate = series.candidate[0];
    expect(emptyCandidate?.reason).toBe('no_runs_in_bucket');
  }, 60_000);

  test('a bucket with runs but no scores reports `no_scores_in_bucket`', async () => {
    const hour = 60 * 60 * 1000;
    const now = Math.floor(Date.now() / hour) * hour;
    const commit = 'unscored_commit_series';
    await sql`
      insert into runs (
        id, factory, definition_commit, definition_dirty, harness, model, runner, kind,
        title, input, status, workflow_id, started_at, ended_at
      ) values (
        'run_series_unscored', ${FACTORY_SERIES}, ${commit}, false, 'fake', null, 'fake', 'run',
        null, ${{}}::jsonb, 'ok', 'run-run_series_unscored', ${new Date(now - 2 * hour).toISOString()}::timestamptz,
        ${new Date(now - 2 * hour).toISOString()}::timestamptz
      )
    `;
    const series = await readCanarySeries({
      factory: FACTORY_SERIES,
      rolloutId: 'series_itest_unscored',
      stableCommit: commit,
      candidateCommit: null,
      startedAt: new Date(now - 3 * hour).toISOString(),
      until: new Date(now).toISOString(),
    });
    const bucket = series.stable[1];
    expect(bucket?.runs).toBe(1);
    expect(bucket?.passRate).toBeNull();
    expect(bucket?.reason).toBe('no_scores_in_bucket');
  }, 60_000);
});
