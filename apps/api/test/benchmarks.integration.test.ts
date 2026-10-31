import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { req } from './helpers';
import { SQL } from 'bun';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { closeClient } from '@factory/orchestration';
import {
  listBenchmarkRuns,
  recordBenchmarkAttestation,
} from '@factory/core';
import { createApp } from '../src/app';
import { loadApiConfig, type ApiConfig } from '../src/config';

/**
 * Benchmark API integration (Phase 4b). Needs Postgres + Temporal:
 *
 *   docker compose up -d
 *   DATABASE_URL=postgres://factory:factory@localhost:5433/factory \
 *   TEMPORAL_ADDRESS=localhost:7233 RUN_INTEGRATION=1 \
 *   bun test apps/api/test/benchmarks.integration.test.ts
 *
 * No worker is started: the routes are exercised end to end without racing compose. The
 * fake harness/forge and the stub judge keep this credential-free.
 */

const enabled =
  process.env.RUN_INTEGRATION === '1' &&
  Boolean(process.env.DATABASE_URL) &&
  Boolean(process.env.TEMPORAL_ADDRESS);

const suite = enabled ? describe : describe.skip;

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');
const MIGRATIONS = join(REPO_ROOT, 'packages', 'core', 'migrations');
const FACTORY = 'example-lights-off';

let config: ApiConfig;
let app: Hono;
let sql: SQL;

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

async function postJson(path: string, body: unknown): Promise<Response> {
  return await req(app, path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

interface GateBody {
  factory: string;
  definitionCommit: string;
  required: boolean;
  satisfied: boolean;
  code: string | null;
  suites: { suite: string; configHash: string; attestation: unknown }[];
}

suite('benchmark API', () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.DATABASE_URL as string;
    process.env.TEMPORAL_ADDRESS = process.env.TEMPORAL_ADDRESS as string;
    process.env.TEMPORAL_TASK_QUEUE = `factory-bench-api-itest-${process.pid}-${Date.now()}`;
    process.env.FACTORY_ROOT = join(REPO_ROOT, 'factories');
    process.env.REPO_ROOT = REPO_ROOT;
    process.env.SCORING_JUDGE_MODE = 'stub';

    await migrate(process.env.DATABASE_URL as string);
    sql = new SQL(process.env.DATABASE_URL as string, { max: 2 });
    // E2E/smoke runs share this DB; start from a clean gate state for this factory.
    await sql`delete from benchmark_attestations where factory = ${FACTORY}`;
    await sql`delete from autonomy_state where factory = ${FACTORY}`;
    config = {
      ...loadApiConfig(),
      factoryRoot: join(REPO_ROOT, 'factories'),
      repoRoot: REPO_ROOT,
      benchmarkHarness: 'fake',
      benchmarkRunner: 'fake',
      benchmarkConfirmThresholdUsd: 0.0001,
      benchmarkDefaultRunCostUsd: 0.5,
      benchmarkMaxCostUsd: 10,
      benchmarkPassThreshold: 0.5,
      benchmarkConcurrency: 2,
    };
    app = createApp(config);
  }, 60_000);

  afterAll(async () => {
    await sql`
      delete from benchmark_attestations where factory = ${FACTORY}
    `;
    await sql`delete from benchmark_trials where factory = ${FACTORY}`;
    await sql`delete from benchmark_results where benchmark_run_id in (select id from benchmark_runs where factory = ${FACTORY})`;
    await sql`delete from benchmark_events where factory = ${FACTORY}`;
    await sql`delete from benchmark_runs where factory = ${FACTORY}`;
    await closeClient();
    await sql?.close();
  }, 30_000);

  test('GET /factories/:name/benchmarks projects suites, hash and gate', async () => {
    const response = await req(app, `/factories/${FACTORY}/benchmarks`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      factory: string;
      definitionCommit: string;
      suites: {
        name: string;
        configHash: string;
        trialCount: number;
        configurations: { name: string }[];
        tasks: { slug: string; startingRepoRefs: string[] }[];
      }[];
      benchmarkGate: { required: boolean; satisfied: boolean };
    };
    expect(body.factory).toBe(FACTORY);
    expect(body.definitionCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(body.suites).toHaveLength(1);
    const review = body.suites[0]!;
    expect(review.name).toBe('review');
    expect(review.configHash).toMatch(/^[0-9a-f]{64}$/);
    expect(review.trialCount).toBe(4);
    expect(review.configurations.map((entry) => entry.name)).toEqual(['Baseline', 'Candidate']);
    expect(review.tasks.map((entry) => entry.slug)).toEqual(['broken-doc-link', 'flaky-test']);
    expect(review.tasks.every((task) => task.startingRepoRefs[0]?.split('@')[1]?.length === 40)).toBe(
      true,
    );
    expect(body.benchmarkGate.required).toBe(true);
    expect(body.benchmarkGate.satisfied).toBe(false);
  });

  test('a dry run returns the estimate without starting anything', async () => {
    const before = await listBenchmarkRuns(sql, { factory: FACTORY });
    const response = await postJson(`/factories/${FACTORY}/benchmarks/review/run`, {
      dryRun: true,
      configurations: ['Baseline'],
      tasks: ['flaky-test'],
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      trials: number;
      fullMatrix: boolean;
      estimate: { estimateUsd: number; requiresConfirmation: boolean; thresholdUsd: number };
      configHash: string;
    };
    expect(body.trials).toBe(1);
    expect(body.fullMatrix).toBe(false);
    expect(body.estimate.estimateUsd).toBeGreaterThan(0);
    expect(body.estimate.thresholdUsd).toBe(0.0001);
    expect(body.estimate.requiresConfirmation).toBe(true);
    expect(body.configHash).toMatch(/^[0-9a-f]{64}$/);

    const after = await listBenchmarkRuns(sql, { factory: FACTORY });
    expect(after.length).toBe(before.length);
  });

  test('above the threshold the run requires confirmation, then starts', async () => {
    const refused = await postJson(`/factories/${FACTORY}/benchmarks/review/run`, {
      configurations: ['Baseline'],
      tasks: ['flaky-test'],
      maxCostUsd: 5,
    });
    expect(refused.status).toBe(409);
    const refusedBody = (await refused.json()) as { code: string; details?: { estimate?: unknown } };
    expect(refusedBody.code).toBe('cost_confirmation_required');
    expect(refusedBody.details?.estimate).toBeDefined();

    const accepted = await postJson(`/factories/${FACTORY}/benchmarks/review/run`, {
      configurations: ['Baseline'],
      tasks: ['flaky-test'],
      confirm: true,
      maxCostUsd: 5,
    });
    expect(accepted.status).toBe(202);
    const body = (await accepted.json()) as {
      benchmark: { id: string; status: string; maxCostUsd: number; configHash: string };
      workflow: { workflowId: string };
      trials: number;
    };
    expect(body.benchmark.id).toMatch(/^bench_/);
    expect(body.benchmark.maxCostUsd).toBe(5);
    expect(body.benchmark.configHash).toMatch(/^[0-9a-f]{64}$/);
    expect(body.workflow.workflowId).toBe(`benchmark-${body.benchmark.id}`);
    expect(body.trials).toBe(1);
  });

  test('a zero hard cap is refused instead of silently skipping every trial', async () => {
    const response = await postJson(`/factories/${FACTORY}/benchmarks/review/run`, {
      configurations: ['Baseline'],
      tasks: ['flaky-test'],
      confirm: true,
      maxCostUsd: 0,
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { code: string };
    expect(body.code).toBe('invalid_request');
  });

  test('a stale attestation does not satisfy the gate; a matching one does', async () => {
    // Other suites/E2E runs may have left a current attestation or a carried override.
    await sql`delete from benchmark_attestations where factory = ${FACTORY}`;
    await sql`delete from autonomy_state where factory = ${FACTORY}`;

    const gateResponse = await req(app, `/factories/${FACTORY}/benchmark-gate`);
    expect(gateResponse.status).toBe(200);
    const gate = (await gateResponse.json()) as GateBody;
    expect(gate.required).toBe(true);
    expect(gate.satisfied).toBe(false);
    expect(gate.code).toBe('benchmark_attestation_missing');
    const current = gate.suites[0]!;

    // Stale: an attestation for a different definition commit.
    await recordBenchmarkAttestation(sql, {
      id: 'att_stale_itest',
      factory: FACTORY,
      definitionCommit: 'f'.repeat(40),
      suite: current.suite,
      configHash: current.configHash,
      passRate: 1,
      calibrationOk: true,
      passed: true,
    });

    const stillStale = (await (await req(app, `/factories/${FACTORY}/benchmark-gate`)).json()) as GateBody;
    expect(stillStale.satisfied).toBe(false);

    const refused = await postJson('/autonomy', {
      factory: FACTORY,
      enabled: true,
      actor: 'ada',
      reason: 'run lights-off',
    });
    expect(refused.status).toBe(409);
    const refusedBody = (await refused.json()) as { code: string };
    expect(refusedBody.code).toBe('benchmark_attestation_missing');

    // Current: a passing, calibrated attestation for this commit + config hash.
    await recordBenchmarkAttestation(sql, {
      id: 'att_current_itest',
      factory: FACTORY,
      definitionCommit: gate.definitionCommit,
      suite: current.suite,
      configHash: current.configHash,
      passRate: 1,
      calibrationOk: true,
      passed: true,
    });

    const satisfied = (await (await req(app, `/factories/${FACTORY}/benchmark-gate`)).json()) as GateBody;
    expect(satisfied.satisfied).toBe(true);
    expect(satisfied.code).toBeNull();

    const enabled = await postJson('/autonomy', {
      factory: FACTORY,
      enabled: true,
      actor: 'ada',
      reason: 'attestation matches this version',
    });
    expect(enabled.status).toBe(200);
    const enabledBody = (await enabled.json()) as {
      autonomy: { enabled: boolean; benchmarkGateSatisfied: boolean; benchmarkAttestationSatisfied: boolean };
    };
    expect(enabledBody.autonomy.enabled).toBe(true);
    expect(enabledBody.autonomy.benchmarkGateSatisfied).toBe(true);
    expect(enabledBody.autonomy.benchmarkAttestationSatisfied).toBe(true);

    const attestations = (await (await req(app, `/factories/${FACTORY}/attestations`)).json()) as {
      definitionCommit: string;
      attestations: { configHash: string; passed: boolean; calibrationOk: boolean }[];
      benchmarkGate: GateBody;
    };
    expect(attestations.definitionCommit).toBe(gate.definitionCommit);
    expect(attestations.attestations.some((entry) => entry.configHash === current.configHash)).toBe(true);
    expect(attestations.benchmarkGate.satisfied).toBe(true);

    // Restore the kill switch for other suites/tests.
    await postJson('/autonomy', {
      factory: FACTORY,
      enabled: false,
      actor: 'ada',
      reason: 'integration cleanup',
    });
  }, 60_000);
});
