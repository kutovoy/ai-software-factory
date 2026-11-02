import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { SQL } from 'bun';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Worker } from '@temporalio/worker';
import {
  createBenchmarkRun,
  createCalibrationSet,
  findBenchmarkAttestation,
  getBenchmarkRun,
  listBenchmarkEvents,
  listBenchmarkResults,
  listBenchmarkTrials,
  loadOrThrow,
  recordCalibrationResult,
} from '@factory/core';
import {
  benchmarkConfigHash,
  buildBenchmarkTrials,
  createStubJudgeClient,
  loadBenchmarkSuites,
} from '@factory/evals';
import { FakeForge } from '@factory/forge';
import { closeClient, getClient } from '../src/client';
import { closeSql, setSql } from '../src/db';
import { loadConfig, type OrchestrationConfig } from '../src/config';
import { setForge } from '../src/activities/forge';
import { clearEphemeralLeases } from '../src/activities/runner';
import { setScoringJudgeClient } from '../src/activities/scoring';
import { planBenchmarkTrials, startBenchmarkTrial } from '../src/activities/benchmark';
import { startBenchmarkWorkflow } from '../src/benchmark-client';
import { clearSessions } from '../src/sessions';
import { createWorker } from '../src/worker';
import type { BenchmarkWorkflowInput, BenchmarkWorkflowOutcome } from '../src/types';

/**
 * Benchmark integration (Phase 4b).
 *
 * Needs Temporal + Postgres:
 *
 *   docker compose up -d
 *   DATABASE_URL=postgres://factory:factory@localhost:5433/factory \
 *   TEMPORAL_ADDRESS=localhost:7233 RUN_INTEGRATION=1 \
 *   bun test packages/orchestration/test/benchmark.integration.test.ts
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
const FACTORY = 'benchmark-fixture';
const MIGRATIONS = join(REPO_ROOT, 'packages', 'core', 'migrations');

let config: OrchestrationConfig;
let worker: Worker;
let running: Promise<void>;
let factoryRoot: string;
let runsDir: string;
let sql: SQL;
let forge: FakeForge;

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

function planInput(args: {
  benchmarkRunId: string;
  configurations?: string[];
  tasks?: string[];
  maxCostUsd: number;
  estimateUsd: number;
  passThreshold?: number;
}): BenchmarkWorkflowInput {
  const definition = loadOrThrow(factoryRoot);
  const suites = loadBenchmarkSuites(definition);
  const review = suites.find((candidate) => candidate.name === 'review');
  expect(review, 'the example definition must declare the review suite').toBeDefined();

  const trials = buildBenchmarkTrials(review!, {
    ...(args.configurations ? { configurations: args.configurations } : {}),
    ...(args.tasks ? { tasks: args.tasks } : {}),
  });
  const configHash = benchmarkConfigHash(review!, 'a'.repeat(40));

  return {
    benchmarkRunId: args.benchmarkRunId,
    factory: FACTORY,
    factoryRoot,
    repoRoot: REPO_ROOT,
    suite: review!.name,
    definitionCommit: 'a'.repeat(40),
    definitionDirty: false,
    configHash,
    trials: planBenchmarkTrials({ benchmarkRunId: args.benchmarkRunId, trials }),
    harness: 'fake',
    model: 'fake/fake-model',
    runner: 'fake',
    concurrency: 2,
    estimateUsd: args.estimateUsd,
    maxCostUsd: args.maxCostUsd,
    passThreshold: args.passThreshold ?? 0.8,
    fullMatrix: !args.configurations && !args.tasks,
    judgeMode: 'stub',
    permissionTimeoutMs: 30_000,
  };
}

async function runBenchmark(input: BenchmarkWorkflowInput): Promise<BenchmarkWorkflowOutcome> {
  await createBenchmarkRun(sql, {
    id: input.benchmarkRunId,
    factory: input.factory,
    suite: input.suite,
    definitionCommit: input.definitionCommit,
    configHash: input.configHash,
    tasks: [...new Set(input.trials.map((trial) => trial.task))],
    configurations: [...new Set(input.trials.map((trial) => trial.configuration))],
    matrix: input.trials.map((trial) => ({
      configuration: trial.configuration,
      task: trial.task,
    })),
    estimateUsd: input.estimateUsd,
    maxCostUsd: input.maxCostUsd,
    partial: !input.fullMatrix,
    workflowId: `benchmark-${input.benchmarkRunId}`,
  });
  const started = await startBenchmarkWorkflow(input, config);
  const client = await getClient(config);
  return (await client.workflow.getHandle(started.workflowId).result()) as BenchmarkWorkflowOutcome;
}

suite('benchmark workflow on the fake harness + fake forge', () => {
  beforeAll(async () => {
    factoryRoot = mkdtempSync(join(tmpdir(), 'factory-bench-def-'));
    cpSync(EXAMPLE, factoryRoot, { recursive: true });
    const manifestPath = join(factoryRoot, 'factory.yaml');
    writeFileSync(
      manifestPath,
      readFileSync(manifestPath, 'utf8').replace(/^name: example$/m, `name: ${FACTORY}`),
    );

    runsDir = mkdtempSync(join(tmpdir(), 'factory-bench-runs-'));
    process.env.FACTORY_ROOT = join(factoryRoot, '..');
    process.env.RUNS_DIR = runsDir;
    process.env.TEMPORAL_TASK_QUEUE = `factory-bench-itest-${process.pid}-${Date.now()}`;
    process.env.SCORING_JUDGE_MODE = 'stub';

    await migrate(process.env.DATABASE_URL as string);
    setSql(new SQL(process.env.DATABASE_URL as string, { max: 4 }));
    sql = new SQL(process.env.DATABASE_URL as string, { max: 4 });

    // A passing calibration for the current rubric hash + judge model makes judge scores
    // calibrated, which is the precondition for an attestation (ADR-018).
    const registry = loadOrThrow(factoryRoot).resources
      .filter((resource) => resource.kind === 'scorer')
      .map((resource) => resource.name);
    expect(registry).toContain('scope');

    const { loadScorerRegistry } = await import('@factory/evals');
    const scorer = loadScorerRegistry(loadOrThrow(factoryRoot)).find(
      (entry) => entry.name === 'scope',
    );
    expect(scorer).toBeDefined();
    const setId = `cal_bench_${Date.now()}`;
    await createCalibrationSet(sql, {
      id: setId,
      factory: FACTORY,
      scorer: 'scope',
      name: 'benchmark integration golden set',
      minSize: 1,
      threshold: 1,
      tolerance: 0,
    });
    await recordCalibrationResult(sql, {
      setId,
      factory: FACTORY,
      scorer: 'scope',
      rubricHash: scorer!.rubricHash,
      judgeModel: scorer!.judgeModel,
      judgeModelVersion: 'stub-v1',
      sampleSize: 1,
      agreementExact: 1,
      agreementWithinTolerance: 1,
      tolerance: 0,
      threshold: 1,
      confusion: { compliant: { compliant: 1 } },
      verdict: 'pass',
    });

    config = {
      ...loadConfig(),
      taskQueue: process.env.TEMPORAL_TASK_QUEUE as string,
      runsDir,
      maxConcurrentActivityTaskExecutions: 12,
      maxConcurrentWorkflowTaskExecutions: 12,
      benchmarkConcurrency: 2,
    };

    forge = new FakeForge();
    setForge('fake', forge);
    clearSessions();
    clearEphemeralLeases();
    setScoringJudgeClient(createStubJudgeClient());
    worker = await createWorker(config);
    running = worker.run();
  }, 120_000);

  afterAll(async () => {
    worker?.shutdown();
    await running?.catch(() => undefined);
    setScoringJudgeClient(null);
    clearSessions();
    clearEphemeralLeases();
    setForge('fake', null);
    await closeSql();
    await closeClient();
    await sql?.close();
    rmSync(factoryRoot, { recursive: true, force: true });
    rmSync(runsDir, { recursive: true, force: true });
  }, 90_000);

  test('2 tasks × 2 configurations produce a matrix, a frontier and an attestation', async () => {
    const benchmarkRunId = `bench_itest_${Date.now()}`;
    const input = planInput({
      benchmarkRunId,
      maxCostUsd: 10,
      estimateUsd: 2,
      passThreshold: 0.5,
    });
    expect(input.trials).toHaveLength(4);

    const outcome = await runBenchmark(input);
    expect(outcome.error).toBeUndefined();
    expect(outcome.status).toBe('completed');
    expect(outcome.trials).toHaveLength(4);
    expect(outcome.sampleSize).toBe(4);
    expect(outcome.passRate).toBe(1);
    expect(outcome.calibrationOk).toBe(true);
    expect(outcome.passed).toBe(true);
    expect(outcome.attestationId).toBeTruthy();

    const trials = await listBenchmarkTrials(sql, benchmarkRunId);
    expect(trials).toHaveLength(4);
    expect(trials.every((trial) => trial.status === 'ok')).toBe(true);
    expect(trials.every((trial) => trial.passing)).toBe(true);
    expect(trials.every((trial) => trial.startingRepoRefs.length === 1)).toBe(true);
    expect(trials.every((trial) => trial.repo?.startsWith(`bench-${benchmarkRunId}`))).toBe(true);
    expect(trials.every((trial) => trial.definitionCommit === 'a'.repeat(40))).toBe(true);

    const results = await listBenchmarkResults(sql, benchmarkRunId);
    expect(results).toHaveLength(2);
    for (const result of results) {
      expect(result.sampleSize).toBe(2);
      expect(result.passRate).toBe(1);
      expect(result.errors).toBe(0);
      expect(result.frontier).toBe(true);
    }

    const run = await getBenchmarkRun(sql, benchmarkRunId);
    expect(run?.status).toBe('completed');
    expect(run?.passed).toBe(true);
    expect(run?.calibrationOk).toBe(true);
    expect(run?.budgetExhausted).toBe(false);
    expect(run?.configHash).toMatch(/^[0-9a-f]{64}$/);

    const attestation = await findBenchmarkAttestation(sql, {
      factory: FACTORY,
      definitionCommit: 'a'.repeat(40),
      configHash: run!.configHash,
    });
    expect(attestation?.passed).toBe(true);
    expect(attestation?.calibrationOk).toBe(true);
    expect(attestation?.benchmarkRunId).toBe(benchmarkRunId);

    const events = await listBenchmarkEvents(sql, benchmarkRunId);
    expect(events.map((event) => event.type)).toEqual([
      'benchmark.started',
      'benchmark.completed',
    ]);
  }, 240_000);

  test('a zero hard cap skips every trial with budget_exhausted and still completes', async () => {
    const benchmarkRunId = `bench_budget_${Date.now()}`;
    const input = planInput({
      benchmarkRunId,
      tasks: ['flaky-test'],
      maxCostUsd: 0,
      estimateUsd: 2,
      passThreshold: 0.5,
    });

    const outcome = await runBenchmark(input);
    expect(outcome.status).toBe('completed');
    expect(outcome.budgetExhausted).toBe(true);
    expect(outcome.sampleSize).toBe(0);
    expect(outcome.passRate).toBeNull();
    expect(outcome.passed).toBe(false);
    expect(outcome.attestationId).toBeUndefined();
    expect(outcome.skipped).toBe(2);

    const trials = await listBenchmarkTrials(sql, benchmarkRunId);
    expect(trials).toHaveLength(2);
    expect(trials.every((trial) => trial.status === 'skipped')).toBe(true);
    expect(trials.every((trial) => trial.errorCode === 'budget_exhausted')).toBe(true);

    const run = await getBenchmarkRun(sql, benchmarkRunId);
    expect(run?.budgetExhausted).toBe(true);
    // The budget test selects one task, so the run is a partial matrix by definition.
    expect(run?.partial).toBe(true);
    expect(run?.status).toBe('completed');
  }, 180_000);

  test('a failed trial is recorded and excluded; the benchmark still completes', async () => {
    const benchmarkRunId = `bench_partial_${Date.now()}`;
    const input = planInput({
      benchmarkRunId,
      configurations: ['Baseline'],
      maxCostUsd: 10,
      estimateUsd: 2,
      passThreshold: 0.5,
    });
    expect(input.trials).toHaveLength(2);
    // One trial declares a network requirement: hermetic replay must deny it, record the
    // error, and keep the other trial running.
    input.trials[0] = { ...input.trials[0]!, requiresNetwork: true, tags: ['requires-network'] };

    const outcome = await runBenchmark(input);
    expect(outcome.status).toBe('completed');
    expect(outcome.errors).toBe(1);
    expect(outcome.sampleSize).toBe(1);
    expect(outcome.passRate).toBe(1);
    expect(outcome.passed).toBe(true);

    const trials = await listBenchmarkTrials(sql, benchmarkRunId);
    expect(trials).toHaveLength(2);
    const failed = trials.find((trial) => trial.status === 'error');
    const ok = trials.find((trial) => trial.status === 'ok');
    expect(failed?.errorCode).toBe('network_denied');
    expect(failed?.runId).toBeNull();
    expect(ok?.runId).toBeTruthy();
    expect(ok?.passing).toBe(true);
  }, 240_000);

  test('a hermetic trial that requires network fails with network_denied', async () => {
    const input = planInput({
      benchmarkRunId: `bench_network_${Date.now()}`,
      maxCostUsd: 10,
      estimateUsd: 1,
    });
    const trial = { ...input.trials[0]!, requiresNetwork: true, tags: ['requires-network'] };

    try {
      await startBenchmarkTrial({ input, trial });
      throw new Error('expected network_denied');
    } catch (error) {
      expect((error as { type?: string }).type).toBe('network_denied');
    }
  });

  test('a replay trial carries its recording and a missing one fails with replay_missing', async () => {
    const benchmarkRunId = `bench_replay_${Date.now()}`;
    const input = planInput({ benchmarkRunId, maxCostUsd: 10, estimateUsd: 1 });
    await createBenchmarkRun(sql, {
      id: benchmarkRunId,
      factory: input.factory,
      suite: input.suite,
      definitionCommit: input.definitionCommit,
      configHash: input.configHash,
      tasks: [...new Set(input.trials.map((trial) => trial.task))],
      configurations: [...new Set(input.trials.map((trial) => trial.configuration))],
      matrix: input.trials.map((trial) => ({ configuration: trial.configuration, task: trial.task })),
      estimateUsd: input.estimateUsd,
      maxCostUsd: input.maxCostUsd,
      partial: true,
      workflowId: `benchmark-${benchmarkRunId}`,
    });

    const recordingId = `run_replay_${Date.now()}`;
    const recording = join(runsDir, recordingId);
    mkdirSync(recording, { recursive: true });
    writeFileSync(join(recording, 'events.jsonl'), '');
    writeFileSync(join(recording, 'patch.diff'), '');

    const trial = { ...input.trials[0]!, replayFrom: recordingId };
    const run = await startBenchmarkTrial({ input, trial });
    expect(run.replayFrom).toBe(recordingId);
    expect(run.proxyModels).toEqual([]);
    expect(run.hermetic).toBe(true);

    const missing = { ...input.trials[1]!, replayFrom: 'run_missing_replay' };
    try {
      await startBenchmarkTrial({ input, trial: missing });
      throw new Error('expected replay_missing');
    } catch (error) {
      expect((error as { type?: string }).type).toBe('replay_missing');
    }
  }, 120_000);
});
