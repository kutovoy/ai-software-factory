import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { S3ArtifactStore } from '../src/artifact-store';
import { loadConfig } from '../src/config';
import type { getSql } from '../src/db';
import {
  artifactKeysOf,
  selectRetentionCandidates,
  sweepFactoryRetention,
  type RetentionRunRow,
} from '../src/retention';

/**
 * Retention unit tests (change `add-retention-quotas-promotion`, task 1.5). DB-free: the
 * selection helper is pure and the sweep takes an injected SQL client, a fake artifact
 * store and a temporary runs directory, so no Postgres is required.
 */

const NOW = new Date('2026-11-05T00:00:00.000Z');

interface DbRunRow {
  id: string;
  status: string;
  started_at: string | number | Date | null;
  ended_at: string | number | Date | null;
  artifacts: unknown;
}

/** Minimal tagged-template SQL stub: returns run rows and records delete statements. */
function fakeSql(rows: DbRunRow[], deletes: string[] = []): ReturnType<typeof getSql> {
  const query = (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
    const text = strings.join('?').toLowerCase();
    if (text.includes('delete')) {
      deletes.push(`${text.trim()} [${values.join(',')}]`);
      return Promise.resolve([]);
    }
    if (text.includes('from runs') && text.includes('where factory')) return Promise.resolve(rows);
    return Promise.resolve([]);
  };
  const sql = Object.assign(query, {
    begin: async (fn: (tx: unknown) => Promise<unknown>) => fn(query),
  });
  return sql as unknown as ReturnType<typeof getSql>;
}

function run(
  id: string,
  status: string,
  endedAt: string | null,
  startedAt = '2026-01-01T00:00:00.000Z',
): RetentionRunRow {
  return { id, status, startedAt, endedAt };
}

const runs: RetentionRunRow[] = [
  run('r1', 'ok', '2026-09-01T00:00:00.000Z'),
  run('r2', 'error', '2026-09-15T00:00:00.000Z'),
  run('r3', 'cancelled', '2026-10-20T00:00:00.000Z'),
  run('r4', 'running', null, '2026-01-01T00:00:00.000Z'),
  run('r5', 'pending', null, '2026-01-01T00:00:00.000Z'),
  run('r6', 'ok', '2026-10-05T00:00:00.000Z'),
];

describe('selectRetentionCandidates', () => {
  test('keeps the newest N terminal runs and removes old ones beyond the keep count', () => {
    const selection = selectRetentionCandidates(runs, { now: NOW, days: 30, keep: 2 });

    expect(selection.scanned).toBe(6);
    expect(selection.kept).toEqual(['r3', 'r6']); // newest first
    expect(selection.protected.sort()).toEqual(['r4', 'r5']);
    // Oldest first; r2 and r1 are older than the 30-day cutoff and beyond the keep count.
    expect(selection.remove).toEqual(['r1', 'r2']);
  });

  test('never removes recent terminal runs, even beyond the keep count', () => {
    const selection = selectRetentionCandidates(runs, { now: NOW, days: 30, keep: 0 });
    expect(selection.kept).toEqual([]);
    expect(selection.remove).toEqual(['r1', 'r2', 'r6']); // only r3 is recent
  });

  test('protects pending/running and any undatable row', () => {
    const selection = selectRetentionCandidates(
      [
        run('active', 'running', null, '2020-01-01T00:00:00.000Z'),
        run('waiting', 'pending', null, '2020-01-01T00:00:00.000Z'),
        run('queued', 'queued', null, '2020-01-01T00:00:00.000Z'),
        { id: 'undated', status: 'ok', startedAt: null, endedAt: null },
        run('old', 'ok', '2020-01-01T00:00:00.000Z'),
      ],
      { now: NOW, days: 30, keep: 0 },
    );
    expect(selection.protected.sort()).toEqual(['active', 'queued', 'undated', 'waiting']);
    expect(selection.remove).toEqual(['old']);
  });

  test('is deterministic for equal timestamps (id tie-break)', () => {
    const tie = '2026-09-01T00:00:00.000Z';
    const selection = selectRetentionCandidates(
      [run('b', 'ok', tie), run('a', 'ok', tie), run('c', 'ok', tie)],
      { now: NOW, days: 30, keep: 1 },
    );
    expect(selection.kept).toEqual(['a']);
    expect(selection.remove).toEqual(['c', 'b']); // oldest first, then reversed ids
  });
});

describe('artifactKeysOf', () => {
  test('collects storage keys and ignores local-only artifacts', () => {
    expect(
      artifactKeysOf({
        id: 'r1',
        status: 'ok',
        artifacts: [
          { path: 'a.log', bytes: 1, sha256: 'a', kind: 'log', storageKey: 'tenants/t/runs/r1/a.log' },
          { path: 'b.log', bytes: 1, sha256: 'b', kind: 'log' },
          { path: 'c.log', bytes: 1, sha256: 'c', kind: 'log', storageKey: 'tenants/t/runs/r1/c.log' },
        ],
      }),
    ).toEqual(['tenants/t/runs/r1/a.log', 'tenants/t/runs/r1/c.log']);
  });

  test('tolerates missing or malformed artifacts', () => {
    expect(artifactKeysOf(undefined)).toEqual([]);
    expect(artifactKeysOf({ id: 'r1', status: 'ok', artifacts: 'not-json' })).toEqual([]);
  });
});

describe('sweepFactoryRetention', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function setup(): { runsDir: string; config: ReturnType<typeof loadConfig> } {
    const runsDir = mkdtempSync(join(tmpdir(), 'retention-'));
    dirs.push(runsDir);
    mkdirSync(join(runsDir, 'r1'), { recursive: true });
    return {
      runsDir,
      config: { ...loadConfig({} as NodeJS.ProcessEnv), runsDir, retentionDays: 30, retentionKeepRuns: 2 },
    };
  }

  const dbRows: DbRunRow[] = runs.map((row) => ({
    id: row.id,
    status: row.status,
    started_at: row.startedAt ?? null,
    ended_at: row.endedAt ?? null,
    artifacts: [],
  }));

  test('dry run reports the plan and deletes nothing', async () => {
    const { runsDir, config } = setup();
    const deletes: string[] = [];

    const result = await sweepFactoryRetention({
      config,
      factory: 'demo',
      dryRun: true,
      now: NOW,
      sql: fakeSql(dbRows, deletes),
    });

    expect(result.dryRun).toBe(true);
    expect(result.removed).toBe(2);
    expect(result.removedRunIds).toEqual(['r1', 'r2']);
    expect(result.kept).toBe(2);
    expect(result.protected).toBe(2);
    expect(result.runDirsRemoved).toBe(0);
    expect(result.artifactsDeleted).toBe(0);
    expect(result.errors).toEqual([]);
    expect(deletes).toEqual([]);
    expect(existsSync(join(runsDir, 'r1'))).toBe(true);
  });

  test('deletes run_secrets, score_runs and runs, then the run directory', async () => {
    const { runsDir, config } = setup();
    const deletes: string[] = [];
    const deletedKeys: string[] = [];
    const store = {
      deleteStoredObject: async (key: string) => {
        deletedKeys.push(key);
        return true;
      },
    } as unknown as S3ArtifactStore;

    const rows: DbRunRow[] = dbRows.map((row) =>
      row.id === 'r1'
        ? {
            ...row,
            artifacts: [
              { path: 'a.log', bytes: 1, sha256: 'a', kind: 'log', storageKey: 'tenants/t/runs/r1/a.log' },
            ],
          }
        : row,
    );

    const result = await sweepFactoryRetention({
      config,
      factory: 'demo',
      now: NOW,
      sql: fakeSql(rows, deletes),
      store,
    });

    expect(result.removed).toBe(2);
    expect(result.runDirsRemoved).toBe(1); // r2 has no directory; that is not an error
    expect(result.artifactsDeleted).toBe(1);
    expect(result.artifactsFailed).toBe(0);
    expect(deletedKeys).toEqual(['tenants/t/runs/r1/a.log']);
    expect(result.errors).toEqual([]);

    for (const runId of ['r1', 'r2']) {
      expect(deletes.some((entry) => entry.includes('delete from run_secrets') && entry.includes(runId))).toBe(true);
      expect(deletes.some((entry) => entry.includes('delete from score_runs') && entry.includes(runId))).toBe(true);
      expect(deletes.some((entry) => entry.includes('delete from runs') && entry.includes(runId))).toBe(true);
    }
    expect(existsSync(join(runsDir, 'r1'))).toBe(false);
  });

  test('reports a failed blob deletion without failing the sweep', async () => {
    const { config } = setup();
    const store = {
      deleteStoredObject: async () => false,
    } as unknown as S3ArtifactStore;
    const rows: DbRunRow[] = dbRows.map((row) =>
      row.id === 'r1'
        ? {
            ...row,
            artifacts: [
              { path: 'a.log', bytes: 1, sha256: 'a', kind: 'log', storageKey: 'tenants/t/runs/r1/a.log' },
            ],
          }
        : row,
    );

    const result = await sweepFactoryRetention({
      config,
      factory: 'demo',
      now: NOW,
      sql: fakeSql(rows),
      store,
    });

    expect(result.removed).toBe(2);
    expect(result.artifactsDeleted).toBe(0);
    expect(result.artifactsFailed).toBe(1);
    expect(result.errors).toEqual([]);
  });
});
