import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { SQL } from 'bun';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Worker } from '@temporalio/worker';
import {
  getScore,
  listScoreEvents,
  listScores,
  type ScoreRecord,
} from '@factory/core';
import { JudgeError, createStubJudgeClient } from '@factory/evals';
import { closeClient, getClient } from '../src/client';
import { closeSql, setSql } from '../src/db';
import { loadConfig, type OrchestrationConfig } from '../src/config';
import { artifactsDir, runDir } from '../src/run-dir';
import { createWorker } from '../src/worker';
import { setScoringJudgeClient } from '../src/activities/scoring';
import { startScoringWorkflow } from '../src/scoring-client';
import { startRun } from '../src/client';
import type { RunInput, ScoringWorkflowOutcome } from '../src/types';

/**
 * Scoring integration (Phase 4a).
 *
 * Needs Temporal + Postgres:
 *
 *   docker compose up -d
 *   DATABASE_URL=postgres://factory:factory@localhost:5433/factory \
 *   TEMPORAL_ADDRESS=localhost:7233 RUN_INTEGRATION=1 \
 *   bun test packages/orchestration/test/scoring.integration.test.ts
 *
 * Everything runs on the fake harness + fake forge + stub judge: no network, no credentials.
 */

const enabled =
  process.env.RUN_INTEGRATION === '1' &&
  Boolean(process.env.DATABASE_URL) &&
  Boolean(process.env.TEMPORAL_ADDRESS);

const suite = enabled ? describe : describe.skip;

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');
const EXAMPLE = join(REPO_ROOT, 'factories', 'example');
const FACTORY = 'scoring-fixture';
const MIGRATIONS = join(REPO_ROOT, 'packages', 'core', 'migrations');

let config: OrchestrationConfig;
let worker: Worker;
let running: Promise<void>;
let factoryRoot: string;
let runsDir: string;
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

function writeDeterministicScorer(root: string): void {
  mkdirSync(join(root, 'scorers/checks'), { recursive: true });
  writeFileSync(
    join(root, 'scorers/checks/scorer.md'),
    [
      '---',
      'agents:',
      '  - implement',
      'description: Did the run pass its deterministic checks?',
      'judgeModel: stub',
      'labels:',
      '  - value: pass',
      '    score: 1',
      '  - value: fail',
      '    score: 0',
      'output: classification',
      'passingScore: 1',
      'samplingRate: 100',
      'selfImprovement: false',
      '---',
      '',
      'Evaluate the run artifacts.',
      '',
      'checks:',
      '  - tests',
      '  - build',
      '  - lint',
      '',
    ].join('\n'),
  );
}

async function runFakeRun(runId: string): Promise<string> {
  const input: RunInput = {
    runId,
    factory: FACTORY,
    factoryRoot,
    definitionCommit: 'a'.repeat(40),
    definitionDirty: false,
    harness: 'fake',
    model: 'fake/fake-model',
    runner: 'fake',
    prompt: { text: 'integration: fix the broken readme link' },
    kind: 'run',
    title: 'integration run',
    proxyModels: [],
    autoAllowPermissions: true,
  };
  const client = await getClient(config);
  await client.workflow.start('RunWorkflow', {
    taskQueue: config.taskQueue,
    workflowId: `run-${runId}`,
    args: [input],
    workflowExecutionTimeout: '10 minutes',
    workflowTaskTimeout: '30 seconds',
  });
  const result = await client.workflow.getHandle(`run-${runId}`).result();
  return (result as { status: string }).status;
}

async function scoreRun(runId: string): Promise<ScoringWorkflowOutcome> {
  const client = await getClient(config);
  const started = await startScoringWorkflow(
    {
      factory: FACTORY,
      factoryRoot,
      trigger: 'on_demand',
      runIds: [runId],
      force: true,
      judgeMode: 'stub',
    },
    config,
  );
  return (await client.workflow
    .getHandle(started.workflowId)
    .result()) as ScoringWorkflowOutcome;
}

function byScorer(scores: ScoreRecord[], scorer: string): ScoreRecord {
  const found = scores.find((score) => score.scorer === scorer);
  expect(found, `missing score for ${scorer}`).toBeDefined();
  return found!;
}

suite('scoring workflow', () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.DATABASE_URL as string;
    process.env.TEMPORAL_ADDRESS = process.env.TEMPORAL_ADDRESS as string;
    process.env.TEMPORAL_TASK_QUEUE = `factory-scoring-itest-${process.pid}-${Date.now()}`;
    process.env.SCORING_JUDGE_MODE = 'stub';

    factoryRoot = mkdtempSync(join(tmpdir(), 'factory-scoring-def-'));
    cpSync(EXAMPLE, factoryRoot, { recursive: true });
    const manifestPath = join(factoryRoot, 'factory.yaml');
    writeFileSync(
      manifestPath,
      readFileSync(manifestPath, 'utf8').replace(/^name: example$/m, `name: ${FACTORY}`),
    );
    writeDeterministicScorer(factoryRoot);

    runsDir = mkdtempSync(join(tmpdir(), 'factory-scoring-runs-'));
    process.env.FACTORY_ROOT = join(factoryRoot, '..');
    process.env.RUNS_DIR = runsDir;

    await migrate(process.env.DATABASE_URL as string);
    setSql(new SQL(process.env.DATABASE_URL as string, { max: 4 }));
    sql = new SQL(process.env.DATABASE_URL as string, { max: 4 });

    config = loadConfig();
    setScoringJudgeClient(createStubJudgeClient());
    worker = await createWorker(config);
    running = worker.run();
  }, 120_000);

  afterAll(async () => {
    setScoringJudgeClient(null);
    await worker?.shutdown();
    await running?.catch(() => undefined);
    await closeClient();
    await closeSql();
    await sql?.close();
    rmSync(factoryRoot, { recursive: true, force: true });
    rmSync(runsDir, { recursive: true, force: true });
  }, 60_000);

  test('scores a completed fake-harness run deterministically + with the stub judge', async () => {
    const runId = `run_itest_score_${Date.now()}`;
    expect(await runFakeRun(runId)).toBe('ok');

    // The fake harness runs `ls -la`, not tests/build/lint; seed the checks artifact so the
    // deterministic path has real evidence.
    const checksPath = join(artifactsDir(runsDir, runId), 'checks.json');
    mkdirSync(join(runDir(runsDir, runId), 'artifacts'), { recursive: true });
    writeFileSync(checksPath, JSON.stringify({ tests: true, build: true, lint: true }));

    const outcome = await scoreRun(runId);
    expect(outcome.error).toBeUndefined();
    expect(outcome.scored).toBeGreaterThanOrEqual(2);
    expect(outcome.errored).toBe(0);

    const scores = await listScores(sql, { factory: FACTORY, runId });
    expect(scores).toHaveLength(2);

    const deterministic = byScorer(scores, 'checks');
    expect(deterministic.scorerClass).toBe('deterministic');
    expect(deterministic.status).toBe('ok');
    expect(deterministic.label).toBe('pass');
    expect(deterministic.score).toBe(1);
    expect(deterministic.passing).toBe(true);
    expect(deterministic.evidenceRefs).toContain('artifact:checks.json');

    const judge = byScorer(scores, 'scope');
    expect(judge.scorerClass).toBe('judge');
    expect(judge.status).toBe('ok');
    expect(judge.label).toBe('compliant');
    expect(judge.passing).toBe(true);
    expect(judge.provenance.judgeModel).toBe('anthropic/claude-haiku-4-5');
    expect(judge.provenance.judgeModelVersion).toBe('stub-v1');
    expect(judge.rubricHash).toMatch(/^[0-9a-f]{64}$/);
    expect(judge.provenance.promptHash).toMatch(/^[0-9a-f]{64}$/);
    expect(judge.provenance.costUsd).toBe(0);
    // No passing calibration exists for this rubric hash yet.
    expect(judge.uncalibrated).toBe(true);

    for (const score of scores) {
      const events = await listScoreEvents(sql, score.id);
      expect(events.map((event) => event.type)).toEqual(['score.completed']);
    }

    const before = (await listScoreEvents(sql, judge.id)).length;

    // Re-scoring the same frozen run with the same rubric is idempotent: no second row, no
    // second `score.completed`.
    await scoreRun(runId);
    const rescored = await listScores(sql, { factory: FACTORY, runId });
    expect(rescored).toHaveLength(2);
    expect((await listScoreEvents(sql, judge.id)).length).toBe(before);

    // Evidence is queryable by id, with the run event/artifact refs.
    const detail = await getScore(sql, judge.id);
    expect(detail).not.toBeNull();
    expect(detail!.score.evidenceRefs.length).toBeGreaterThan(0);
    expect(detail!.score.evidence?.some((item) => item.kind === 'event')).toBe(true);
  }, 180_000);

  test('missing artifacts and judge failures are error scores; the run is untouched', async () => {
    const runId = `run_itest_missing_${Date.now()}`;
    expect(await runFakeRun(runId)).toBe('ok');

    // No checks.json: the deterministic scorer must report missing_artifact, not a pass.
    const outcome = await scoreRun(runId);
    expect(outcome.errored).toBeGreaterThanOrEqual(1);
    const scores = await listScores(sql, { factory: FACTORY, runId });
    const deterministic = byScorer(scores, 'checks');
    expect(deterministic.status).toBe('error');
    expect(deterministic.errorCode).toBe('missing_artifact');
    expect(deterministic.label).toBeNull();
    expect(deterministic.score).toBeNull();

    // The run itself is unaffected by scoring.
    const run = await sql`select status from runs where id = ${runId} limit 1`;
    expect(run[0]?.status).toBe('ok');

    // A failing judge becomes a judge_unavailable error score, never a thrown workflow.
    setScoringJudgeClient({
      id: 'failing',
      async complete() {
        throw new JudgeError('judge_unavailable', 'judge endpoint is down');
      },
    });
    const failed = await scoreRun(runId);
    expect(failed.errored).toBeGreaterThanOrEqual(2);
    const after = await listScores(sql, { factory: FACTORY, runId });
    const judge = byScorer(after, 'scope');
    expect(judge.status).toBe('error');
    expect(judge.errorCode).toBe('judge_unavailable');
    expect(judge.passing).toBe(false);
    setScoringJudgeClient(createStubJudgeClient());
  }, 180_000);

  test('budget exhaustion skips judges but deterministic scoring continues', async () => {
    const runId = `run_itest_budget_${Date.now()}`;
    expect(await runFakeRun(runId)).toBe('ok');
    mkdirSync(join(runDir(runsDir, runId), 'artifacts'), { recursive: true });
    writeFileSync(
      join(artifactsDir(runsDir, runId), 'checks.json'),
      JSON.stringify({ tests: true, build: true, lint: true }),
    );

    const client = await getClient(config);
    const started = await startScoringWorkflow(
      {
        factory: FACTORY,
        factoryRoot,
        trigger: 'on_demand',
        runIds: [runId],
        force: true,
        judgeMode: 'stub',
        maxScoresPerDay: 0,
      },
      config,
    );
    const outcome = (await client.workflow
      .getHandle(started.workflowId)
      .result()) as ScoringWorkflowOutcome;
    expect(outcome.budgetExhausted).toBe(true);

    const scores = await listScores(sql, { factory: FACTORY, runId });
    const deterministic = byScorer(scores, 'checks');
    expect(deterministic.status).toBe('ok');
    const judge = byScorer(scores, 'scope');
    expect(judge.status).toBe('skipped');
    expect(judge.errorCode).toBe('budget_exhausted');
    expect(judge.score).toBeNull();
  }, 180_000);
});
