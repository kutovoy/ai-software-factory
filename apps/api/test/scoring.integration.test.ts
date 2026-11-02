import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { factoryIdOf, req } from './helpers';
import { SQL } from 'bun';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { closeSql } from '@factory/orchestration';
import { createApp } from '../src/app';
import { loadApiConfig, type ApiConfig } from '../src/config';

/**
 * Calibration API integration (Phase 4a). Needs Postgres only:
 *
 *   docker compose up -d postgres
 *   DATABASE_URL=postgres://factory:factory@localhost:5433/factory RUN_INTEGRATION=1 \
 *   bun test apps/api/test/scoring.integration.test.ts
 *
 * The stub judge keeps this credential-free and network-free.
 */

const enabled = process.env.RUN_INTEGRATION === '1' && Boolean(process.env.DATABASE_URL);
const suite = enabled ? describe : describe.skip;

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');
const EXAMPLE = join(REPO_ROOT, 'factories', 'example');
const MIGRATIONS = join(REPO_ROOT, 'packages', 'core', 'migrations');
const FACTORY = 'calibration-fixture';

let config: ApiConfig;
let app: Hono;
let sql: SQL;
let runsDir: string;
let factoryRoot: string;
let factoryId: string;

async function migrate(databaseUrl: string): Promise<void> {
  const client = new SQL(databaseUrl, { max: 1 });
  try {
    const files = (await readdir(MIGRATIONS)).filter((file) => file.endsWith('.sql')).sort();
    for (const file of files) {
      await client.unsafe(await readFile(join(MIGRATIONS, file), 'utf8'));
    }
  } finally {
    await client.close();
  }
}

async function insertTerminalRun(runId: string): Promise<void> {
  await sql`
    insert into runs (
      id, factory, definition_commit, definition_dirty, harness, model, runner, kind,
      title, input, status, workflow_id, started_at, ended_at
    ) values (
      ${runId}, ${FACTORY}, ${'b'.repeat(40)}, false, 'fake', 'fake/fake-model', 'fake', 'run',
      'calibration fixture', ${JSON.stringify({ prompt: { text: 'fix the broken readme link' } })}::jsonb,
      'ok', ${`run-${runId}`}, now(), now()
    )
    on conflict (id) do nothing
  `;
  await sql`
    insert into events (run_id, seq, type, ts, payload)
    values (
      ${runId}, 1, 'run.completed', ${Date.now()},
      ${JSON.stringify({ type: 'run.completed', seq: 1, at: Date.now(), status: 'ok' })}::jsonb
    )
    on conflict (run_id, seq) do nothing
  `;
}

async function postCalibration(body: unknown): Promise<Response> {
  return await req(app, `/factories/${factoryId}/calibration`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

suite('calibration API', () => {
  beforeAll(async () => {
    factoryRoot = mkdtempSync(join(tmpdir(), 'factory-cal-def-'));
    cpSync(EXAMPLE, join(factoryRoot, FACTORY), { recursive: true });
    const manifestPath = join(factoryRoot, FACTORY, 'factory.yaml');
    writeFileSync(
      manifestPath,
      readFileSync(manifestPath, 'utf8').replace(/^name: example$/m, `name: ${FACTORY}`),
    );
    process.env.FACTORY_ROOT = factoryRoot;
    process.env.REPO_ROOT = REPO_ROOT;
    process.env.SCORING_JUDGE_MODE = 'stub';
    runsDir = mkdtempSync(join(tmpdir(), 'factory-cal-runs-'));
    process.env.RUNS_DIR = runsDir;

    await migrate(process.env.DATABASE_URL as string);
    sql = new SQL(process.env.DATABASE_URL as string, { max: 2 });
    config = loadApiConfig();
    app = createApp(config);
    factoryId = await factoryIdOf(app, FACTORY);
  }, 60_000);

  afterAll(async () => {
    await closeSql();
    await sql?.close();
    rmSync(runsDir, { recursive: true, force: true });
    rmSync(factoryRoot, { recursive: true, force: true });
  }, 30_000);

  test('insufficient_data below the minimum size, then a passing verdict', async () => {
    const runId = `run_cal_${Date.now()}`;
    await insertTerminalRun(runId);

    const tooSmall = await postCalibration({
      scorer: 'scope',
      name: 'small golden set',
      minSize: 5,
      items: [{ runId, humanLabel: 'compliant' }],
    });
    expect(tooSmall.status).toBe(201);
    const small = (await tooSmall.json()) as {
      calibration: {
        status: string;
        verdict: string;
        agreementExact: number | null;
        sampleSize: number;
        reason?: string;
      };
      result: { verdict: string };
    };
    expect(small.calibration.status).toBe('insufficient_data');
    expect(small.calibration.verdict).toBe('insufficient_data');
    expect(small.calibration.agreementExact).toBeNull();
    expect(small.calibration.reason).toContain('at least 5');

    const before = await req(app, `/factories/${factoryId}/calibration/scope`);
    expect(before.status).toBe(200);
    const beforeBody = (await before.json()) as {
      calibrated: boolean;
      latest: { verdict: string } | null;
    };
    expect(beforeBody.calibrated).toBe(false);
    expect(beforeBody.latest?.verdict).toBe('insufficient_data');

    const passing = await postCalibration({
      scorer: 'scope',
      name: 'passing golden set',
      minSize: 1,
      threshold: 1,
      items: [{ runId, humanLabel: 'compliant' }],
    });
    expect(passing.status).toBe(201);
    const pass = (await passing.json()) as {
      calibration: {
        verdict: string;
        agreementExact: number;
        agreementWithinTolerance: number;
        sampleSize: number;
        confusion: Record<string, Record<string, number>>;
      };
      result: { verdict: string; rubricHash: string; judgeModel: string };
      judgeModelVersion: string | null;
      items: { judgeLabel: string | null; error: string | null }[];
    };
    expect(pass.calibration.verdict).toBe('pass');
    expect(pass.calibration.agreementExact).toBe(1);
    expect(pass.calibration.agreementWithinTolerance).toBe(1);
    expect(pass.calibration.confusion).toEqual({ compliant: { compliant: 1 } });
    expect(pass.result.verdict).toBe('pass');
    expect(pass.result.rubricHash).toMatch(/^[0-9a-f]{64}$/);
    expect(pass.result.judgeModel).toBe('anthropic/claude-haiku-4-5');
    expect(pass.judgeModelVersion).toBe('stub-v1');
    expect(pass.items[0]?.judgeLabel).toBe('compliant');
    expect(pass.items[0]?.error).toBeNull();

    const after = await req(app, `/factories/${factoryId}/calibration/scope`);
    expect(after.status).toBe(200);
    const afterBody = (await after.json()) as {
      calibrated: boolean;
      latest: { verdict: string; agreementExact: number } | null;
      sets: { itemCount: number }[];
    };
    expect(afterBody.calibrated).toBe(true);
    expect(afterBody.latest?.verdict).toBe('pass');
    expect(afterBody.latest?.agreementExact).toBe(1);
    expect(afterBody.sets.length).toBeGreaterThanOrEqual(2);
  }, 60_000);

  test('calibration rejects a label the scorer does not declare', async () => {
    const runId = `run_cal_bad_${Date.now()}`;
    await insertTerminalRun(runId);
    const response = await postCalibration({
      scorer: 'scope',
      minSize: 1,
      items: [{ runId, humanLabel: 'great' }],
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { code: string };
    expect(body.code).toBe('invalid_request');
  });
});
