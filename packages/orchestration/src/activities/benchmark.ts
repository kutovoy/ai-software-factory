import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { ApplicationFailure } from '@temporalio/activity';
import {
  aggregateBenchmark,
  benchmarkConfigHash,
  buildBenchmarkTrials,
  estimateBenchmarkCost,
  findBenchmarkSuite,
  isFullMatrix,
  loadBenchmarkSuites,
  loadScorerRegistry,
  paretoFrontier,
  type BenchmarkAggregate,
  type BenchmarkSuiteDescriptor,
  type BenchmarkTrialPlanItem,
  type CostEstimate,
  type ParetoAnalysis,
} from '@factory/evals';
import {
  comparableRunCosts,
  countJudgeScoresToday,
  createBenchmarkRun,
  finishBenchmarkRun,
  getBenchmarkRun,
  listBenchmarkTrials,
  listScores,
  loadDefinition,
  markBenchmarkRunning,
  recordBenchmarkAttestation,
  recordBenchmarkEvent,
  recordBenchmarkTrial,
  upsertBenchmarkResult,
  type BenchmarkRunRecord,
  type BenchmarkTrialRecord,
} from '@factory/core';
import { FakeForge, type RepoRef } from '@factory/forge';
import { prepareWorkspace } from '@factory/runners';
import { loadConfig } from '../config';
import { getSql, getRun, insertRun } from '../db';
import { getForge } from './forge';
import { persistScore, runDeterministic, runJudge } from './scoring';
import { skippedScoreDraft } from '../scoring/drafts';
import { runDir } from '../run-dir';
import type {
  BenchmarkTrialOutcome,
  BenchmarkTrialPlan,
  BenchmarkWorkflowInput,
  RunInput,
  ScoringPlanItem,
} from '../types';
import { benchmarkTrialRunId, runWorkflowIdFor } from '../types';

/**
 * Benchmark activities (Phase 4b).
 *
 * Trials are hermetic child `RunWorkflow`s at a pinned full SHA + definition commit, on a
 * fresh fake-forge repo. Scoring reuses the Phase 4a path (`runDeterministic` / `runJudge`
 * + `persistScore`) so calibration and provenance stay identical to ordinary scoring.
 */

function fail(code: string, message: string, details?: unknown, nonRetryable = true): never {
  throw ApplicationFailure.create({
    type: code,
    nonRetryable,
    message,
    ...(details === undefined ? {} : { details: [details] }),
  });
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function codeOf(error: unknown): string {
  const candidate = (error as { type?: unknown; code?: unknown } | null)?.type ??
    (error as { code?: unknown } | null)?.code;
  return typeof candidate === 'string' ? candidate : 'trial_error';
}

/* ------------------------------------------------------------------ planning */

export interface EstimateBenchmarkArgs {
  factory: string;
  factoryRoot: string;
  suite: string;
  definitionCommit: string;
  configurations?: string[];
  tasks?: string[];
  defaultRunCostUsd?: number;
  thresholdUsd?: number;
}

export interface BenchmarkPlanEstimate {
  factory: string;
  suite: string;
  configHash: string;
  estimate: CostEstimate;
  fullMatrix: boolean;
  configurations: string[];
  tasks: string[];
  trials: BenchmarkTrialPlanItem[];
}

function suitesOf(factoryRoot: string): BenchmarkSuiteDescriptor[] {
  const { definition, errors } = loadDefinition(factoryRoot);
  if (!definition) {
    fail(
      'definition_invalid',
      `benchmark cannot load the definition: ${errors
        .map((error) => `${error.code} ${error.pointer}`)
        .join(', ')}`,
      { errors },
    );
  }
  return loadBenchmarkSuites(definition);
}

function requireSuite(factoryRoot: string, suiteName: string): BenchmarkSuiteDescriptor {
  const suite = findBenchmarkSuite(suitesOf(factoryRoot), suiteName);
  if (!suite) {
    fail('benchmark_suite_not_found', `factory has no benchmark suite "${suiteName}"`, {
      suite: suiteName,
    });
  }
  return suite;
}

/** Estimate cost and resolve the trial plan for a (possibly partial) matrix. */
export async function estimateBenchmarkCostActivity(
  args: EstimateBenchmarkArgs,
): Promise<BenchmarkPlanEstimate> {
  const config = loadConfig();
  const suite = requireSuite(args.factoryRoot, args.suite);
  const trials = buildBenchmarkTrials(suite, {
    ...(args.configurations ? { configurations: args.configurations } : {}),
    ...(args.tasks ? { tasks: args.tasks } : {}),
  });
  const definitionCommit = args.definitionCommit;
  const configHash = benchmarkConfigHash(suite, definitionCommit);
  const costs = await comparableRunCosts(getSql(), { factory: args.factory });
  const estimate = estimateBenchmarkCost({
    trials: trials.length,
    comparableRunCosts: costs,
    fallbackRunCostUsd: args.defaultRunCostUsd ?? config.benchmarkDefaultRunCostUsd,
    thresholdUsd: args.thresholdUsd ?? config.benchmarkConfirmThresholdUsd,
  });

  return {
    factory: args.factory,
    suite: suite.name,
    configHash,
    estimate,
    fullMatrix: isFullMatrix(suite, {
      ...(args.configurations ? { configurations: args.configurations } : {}),
      ...(args.tasks ? { tasks: args.tasks } : {}),
    }),
    configurations: [...new Set(trials.map((trial) => trial.configuration))],
    tasks: [...new Set(trials.map((trial) => trial.task))],
    trials,
  };
}

/* ---------------------------------------------------------------- run/trials */

export async function createBenchmarkRunActivity(
  args: {
    benchmarkRunId: string;
    factory: string;
    suite: string;
    definitionCommit: string;
    configHash: string;
    tasks: string[];
    configurations: string[];
    matrix: { configuration: string; task: string }[];
    estimateUsd: number | null;
    maxCostUsd: number;
    partial: boolean;
    workflowId?: string | null;
    temporalRunId?: string | null;
  },
): Promise<BenchmarkRunRecord> {
  return await createBenchmarkRun(getSql(), {
    id: args.benchmarkRunId,
    factory: args.factory,
    suite: args.suite,
    definitionCommit: args.definitionCommit,
    configHash: args.configHash,
    tasks: args.tasks,
    configurations: args.configurations,
    matrix: args.matrix,
    estimateUsd: args.estimateUsd,
    maxCostUsd: args.maxCostUsd,
    partial: args.partial,
    workflowId: args.workflowId ?? null,
    temporalRunId: args.temporalRunId ?? null,
  });
}

export async function markBenchmarkRunningActivity(args: {
  benchmarkRunId: string;
  workflowId?: string | null;
  temporalRunId?: string | null;
}): Promise<BenchmarkRunRecord> {
  return await markBenchmarkRunning(getSql(), {
    id: args.benchmarkRunId,
    ...(args.workflowId ? { workflowId: args.workflowId } : {}),
    ...(args.temporalRunId ? { temporalRunId: args.temporalRunId } : {}),
  });
}

export async function finishBenchmarkRunActivity(args: {
  benchmarkRunId: string;
  status: 'completed' | 'error' | 'cancelled';
  spentUsd: number;
  budgetExhausted: boolean;
  passRate?: number | null;
  calibrationOk?: boolean;
  passed?: boolean;
  error?: string | null;
}): Promise<BenchmarkRunRecord> {
  return await finishBenchmarkRun(getSql(), {
    id: args.benchmarkRunId,
    status: args.status,
    spentUsd: args.spentUsd,
    budgetExhausted: args.budgetExhausted,
    passRate: args.passRate ?? null,
    calibrationOk: args.calibrationOk ?? false,
    passed: args.passed ?? false,
    error: args.error ?? null,
  });
}

export async function recordBenchmarkEventActivity(args: {
  benchmarkRunId: string;
  factory: string;
  type: string;
  payload?: Record<string, unknown>;
}): Promise<{ appended: boolean }> {
  const result = await recordBenchmarkEvent(getSql(), args);
  return { appended: result.appended };
}

function repoOf(key: string): RepoRef {
  const [owner, ...rest] = key.split('/');
  return { owner: owner as string, name: rest.join('/') };
}

function startingCommit(trial: BenchmarkTrialPlan): string {
  const first = trial.startingRepoRefs[0] ?? '';
  return first.split('@')[1] ?? '';
}

/**
 * Prepares one hermetic trial: fresh fake-forge repo, pinned SHA + definition commit,
 * trial row in `running`. A task tagged `requires-network` fails with `network_denied`
 * instead of silently reaching the network.
 *
 * A task with `replayFrom` runs the replay adapter instead of a harness: the recording must
 * exist (`replay_missing` otherwise) and the run calls no model.
 */
export async function startBenchmarkTrial(args: {
  input: BenchmarkWorkflowInput;
  trial: BenchmarkTrialPlan;
}): Promise<RunInput> {
  const { input, trial } = args;
  const config = loadConfig();
  const replayFrom = trial.replayFrom ?? null;

  if (replayFrom) {
    const recording = runDir(config.runsDir, replayFrom);
    const hasEvents = existsSync(join(recording, 'events.jsonl'));
    const hasPatch = existsSync(join(recording, 'patch.diff'));
    if (!hasEvents || !hasPatch) {
      fail(
        'replay_missing',
        `trial ${trial.trialId} replays ${replayFrom} but ${recording} is missing events.jsonl or patch.diff`,
        { trialId: trial.trialId, replayFrom, recording, events: hasEvents, patch: hasPatch },
      );
    }
  }

  if (trial.requiresNetwork && !replayFrom) {
    fail('network_denied', `trial ${trial.trialId} requires network; hermetic benchmarks deny it`, {
      trialId: trial.trialId,
      task: trial.task,
      tags: trial.tags,
    });
  }

  // A replay trial wants a fresh checkout to apply the recorded patch to. When the pinned
  // commit is available locally it is prepared here (host-side, like any stage patch);
  // otherwise the replay adapter applies the patch itself, so a patch that does not fit
  // fails the run with `replay_apply_failed` instead of being silently ignored.
  let replayWorkspace: string | undefined;
  if (replayFrom) {
    const workspace = join(runDir(config.runsDir, trial.runId), 'workspace');
    const patch = join(runDir(config.runsDir, replayFrom), 'patch.diff');
    try {
      await prepareWorkspace(
        { path: input.repoRoot ?? input.factoryRoot, commit: startingCommit(trial), patch },
        workspace,
      );
    } catch (error) {
      console.warn(
        `[benchmark] replay ${trial.trialId}: workspace not prepared (${message(error)}); the replay adapter will apply the patch`,
      );
      replayWorkspace = workspace;
    }
  }

  const repo = repoOf(trial.repo);
  const forge = getForge();
  if (forge instanceof FakeForge) {
    // A fresh repo per trial: never reuse state from another trial or run.
    forge.seedRepo(repo, {
      'README.md': `# ${repo.name}\n\nHermetic benchmark trial (${trial.task}).\n`,
      'benchmark-task.md': [
        `# ${trial.task}`,
        '',
        trial.prompt,
        '',
        `Success criteria: ${trial.successCriteria}`,
        '',
        `Pinned refs: ${trial.startingRepoRefs.join(', ')}`,
        `Definition commit: ${input.definitionCommit}`,
        `Configuration: ${trial.configuration}`,
      ].join('\n'),
    });
  }

  const prompt = [
    trial.prompt,
    '',
    `Success criteria: ${trial.successCriteria}`,
    `Benchmark: ${input.suite}`,
    `Task: ${trial.task}`,
    `Configuration: ${trial.configuration}`,
    `Pinned starting refs: ${trial.startingRepoRefs.join(', ')}`,
    `Definition commit: ${input.definitionCommit}`,
    `Config hash: ${input.configHash}`,
  ].join('\n');

  const runInput: RunInput = {
    runId: trial.runId,
    factory: input.factory,
    factoryRoot: input.factoryRoot,
    definitionCommit: input.definitionCommit,
    definitionDirty: input.definitionDirty,
    harness: input.harness,
    ...(input.model ? { model: input.model } : {}),
    runner: input.runner,
    repo: { path: input.repoRoot ?? input.factoryRoot, commit: startingCommit(trial) },
    prompt: { text: prompt },
    kind: 'run',
    title: `benchmark: ${input.suite} · ${trial.configuration} · ${trial.task}`,
    // A replay calls no model, so it gets no proxy token and no proxy models.
    proxyModels: replayFrom ? [] : input.model ? [input.model] : [],
    autoAllowPermissions: true,
    hermetic: true,
    networkPolicy: 'denied',
    ...(replayFrom
      ? {
          replayFrom,
          // Set only when the host-side preparation failed: the adapter then applies the
          // recorded patch to this fresh workspace itself.
          ...(replayWorkspace ? { workspace: replayWorkspace } : {}),
        }
      : {}),
    ...(input.permissionTimeoutMs ? { permissionTimeoutMs: input.permissionTimeoutMs } : {}),
  };

  await insertRun({
    runId: trial.runId,
    factory: input.factory,
    definitionCommit: input.definitionCommit,
    definitionDirty: input.definitionDirty,
    harness: input.harness,
    model: input.model ?? null,
    runner: input.runner,
    kind: 'run',
    title: runInput.title ?? null,
    input: runInput,
    workflowId: runWorkflowIdFor(trial.runId),
  });

  await recordBenchmarkTrial(getSql(), {
    id: trial.trialId,
    benchmarkRunId: input.benchmarkRunId,
    factory: input.factory,
    suite: input.suite,
    configuration: trial.configuration,
    task: trial.task,
    runId: trial.runId,
    status: 'running',
    startingRepoRefs: trial.startingRepoRefs,
    repo: trial.repo,
    definitionCommit: input.definitionCommit,
    configHash: input.configHash,
  });

  return runInput;
}

/** Scores a trial run through the Phase 4a scorer path; best-effort, never fatal. */
async function scoreTrialRun(args: {
  factory: string;
  factoryRoot: string;
  runId: string;
  judgeMode?: 'stub' | 'openai';
}): Promise<void> {
  const sql = getSql();
  const config = loadConfig();
  const { definition } = loadDefinition(args.factoryRoot);
  if (!definition) return;

  const { loadScorerRegistry } = await import('@factory/evals');
  const registry = loadScorerRegistry(definition);
  let judgeUsed = await countJudgeScoresToday(sql, args.factory);

  for (const scorer of registry) {
    if (scorer.scorerClass === 'judge' && judgeUsed >= config.scoringMaxScoresPerDay) {
      const item: ScoringPlanItem = {
        runId: args.runId,
        workItemId: null,
        stage: null,
        scorer: scorer.name,
        scorerClass: 'judge',
        rubricHash: scorer.rubricHash,
        selected: false,
        reason: 'budget_exhausted',
      };
      await persistScore({
        scoreRunId: null,
        draft: skippedScoreDraft(args.factory, item, 'budget_exhausted', 'daily judge budget exhausted'),
      }).catch(() => undefined);
      continue;
    }
    if (scorer.scorerClass === 'judge') judgeUsed += 1;

    try {
      const draft =
        scorer.scorerClass === 'deterministic'
          ? await runDeterministic({
              factory: args.factory,
              factoryRoot: args.factoryRoot,
              runId: args.runId,
              scorer: scorer.name,
              rubricHash: scorer.rubricHash,
            })
          : await runJudge({
              factory: args.factory,
              factoryRoot: args.factoryRoot,
              runId: args.runId,
              scorer: scorer.name,
              rubricHash: scorer.rubricHash,
              ...(args.judgeMode ? { judgeMode: args.judgeMode } : {}),
            });
      await persistScore({ scoreRunId: null, draft });
    } catch {
      // A scorer failure is recorded by `persistScore` when it can; the trial itself is
      // still measured by its run status, so scoring never fails a benchmark.
    }
  }
}

/**
 * Records the terminal trial outcome. A trial that errors is recorded as `error` and
 * excluded from aggregation; the benchmark continues.
 */
export async function finishBenchmarkTrial(args: {
  input: BenchmarkWorkflowInput;
  trial: BenchmarkTrialPlan;
  runStatus: string;
  summary?: string;
}): Promise<BenchmarkTrialOutcome> {
  const sql = getSql();
  const run = await getRun(args.trial.runId);

  await scoreTrialRun({
    factory: args.input.factory,
    factoryRoot: args.input.factoryRoot,
    runId: args.trial.runId,
    ...(args.input.judgeMode ? { judgeMode: args.input.judgeMode } : {}),
  }).catch(() => undefined);

  const scores = await listScores(sql, { factory: args.input.factory, runId: args.trial.runId });
  const okScores = scores.filter((score) => score.status === 'ok');

  const terminalStatus = run?.status ?? args.runStatus;
  const status: BenchmarkTrialOutcome['status'] =
    terminalStatus === 'ok' ? 'ok' : 'error';
  const errorCode =
    status === 'error'
      ? terminalStatus === 'cancelled'
        ? 'cancelled'
        : `run_${terminalStatus}`
      : null;

  const uncalibrated = okScores.some(
    (score) => score.scorerClass === 'judge' && score.uncalibrated,
  );
  const weighted =
    okScores.length === 0
      ? status === 'ok'
        ? 1
        : 0
      : okScores.reduce((total, score) => total + (score.score ?? 0), 0) / okScores.length;
  const passing = status === 'ok' && okScores.every((score) => score.passing);
  const costUsd =
    (run?.cost_usd === null || run?.cost_usd === undefined ? 0 : Number(run.cost_usd)) +
    scores.reduce((total, score) => total + (score.provenance.costUsd ?? 0), 0);

  const trial = await recordBenchmarkTrial(sql, {
    id: args.trial.trialId,
    benchmarkRunId: args.input.benchmarkRunId,
    factory: args.input.factory,
    suite: args.input.suite,
    configuration: args.trial.configuration,
    task: args.trial.task,
    runId: args.trial.runId,
    status,
    errorCode,
    score: Math.round(weighted * 1000) / 1000,
    passing,
    costUsd: Math.round(costUsd * 1_000_000) / 1_000_000,
    uncalibrated,
    startingRepoRefs: args.trial.startingRepoRefs,
    repo: args.trial.repo,
    definitionCommit: args.input.definitionCommit,
    configHash: args.input.configHash,
    endedAt: new Date().toISOString(),
  });

  return trialOutcome(trial);
}

/** Records a trial that never started (forge/network/plan failure). */
export async function failBenchmarkTrial(args: {
  input: BenchmarkWorkflowInput;
  trial: BenchmarkTrialPlan;
  errorCode: string;
  error: string;
}): Promise<BenchmarkTrialOutcome> {
  const trial = await recordBenchmarkTrial(getSql(), {
    id: args.trial.trialId,
    benchmarkRunId: args.input.benchmarkRunId,
    factory: args.input.factory,
    suite: args.input.suite,
    configuration: args.trial.configuration,
    task: args.trial.task,
    runId: null,
    status: 'error',
    errorCode: args.errorCode,
    score: null,
    passing: false,
    costUsd: 0,
    uncalibrated: false,
    startingRepoRefs: args.trial.startingRepoRefs,
    repo: args.trial.repo,
    definitionCommit: args.input.definitionCommit,
    configHash: args.input.configHash,
    endedAt: new Date().toISOString(),
  });
  return trialOutcome(trial);
}

/** Skips a trial because the hard cap is exhausted. */
export async function skipBenchmarkTrial(args: {
  input: BenchmarkWorkflowInput;
  trial: BenchmarkTrialPlan;
  reason: 'budget_exhausted';
}): Promise<BenchmarkTrialOutcome> {
  const trial = await recordBenchmarkTrial(getSql(), {
    id: args.trial.trialId,
    benchmarkRunId: args.input.benchmarkRunId,
    factory: args.input.factory,
    suite: args.input.suite,
    configuration: args.trial.configuration,
    task: args.trial.task,
    runId: null,
    status: 'skipped',
    errorCode: args.reason,
    score: null,
    passing: false,
    costUsd: 0,
    uncalibrated: false,
    startingRepoRefs: args.trial.startingRepoRefs,
    repo: args.trial.repo,
    definitionCommit: args.input.definitionCommit,
    configHash: args.input.configHash,
    endedAt: new Date().toISOString(),
  });
  return trialOutcome(trial);
}

function trialOutcome(trial: BenchmarkTrialRecord): BenchmarkTrialOutcome {
  return {
    trialId: trial.id,
    configuration: trial.configuration,
    task: trial.task,
    runId: trial.runId,
    status: trial.status,
    errorCode: trial.errorCode,
    score: trial.score,
    passing: trial.passing,
    costUsd: trial.costUsd,
    uncalibrated: trial.uncalibrated,
  };
}

/* --------------------------------------------------------------- aggregation */

export interface AggregateBenchmarkResult {
  aggregate: BenchmarkAggregate;
  analysis: ParetoAnalysis;
}

export async function aggregateBenchmarkActivity(args: {
  input: BenchmarkWorkflowInput;
}): Promise<AggregateBenchmarkResult> {
  const sql = getSql();
  const trials = await listBenchmarkTrials(sql, args.input.benchmarkRunId);
  const aggregate = aggregateBenchmark(
    trials.map((trial) => ({
      configuration: trial.configuration,
      task: trial.task,
      status:
        trial.status === 'ok'
          ? ('ok' as const)
          : trial.status === 'skipped'
            ? ('skipped' as const)
            : ('error' as const),
      errorCode: trial.errorCode,
      score: trial.score,
      passing: trial.passing,
      costUsd: trial.costUsd,
      uncalibrated: trial.uncalibrated,
    })),
    { passThreshold: args.input.passThreshold },
  );
  const analysis = paretoFrontier(
    aggregate.configurations.map((configuration) => ({
      configuration: configuration.configuration,
      passRate: configuration.passRate,
      costUsd: configuration.costUsd,
    })),
  );

  for (const configuration of aggregate.configurations) {
    const labels = (Object.entries(analysis.labels) as [string, string | null][])
      .filter(([, value]) => value === configuration.configuration)
      .map(([label]) => label);
    const dominated = analysis.dominated.find(
      (entry) => entry.configuration === configuration.configuration,
    );
    await upsertBenchmarkResult(sql, {
      benchmarkRunId: args.input.benchmarkRunId,
      configuration: configuration.configuration,
      passRate: configuration.passRate,
      weightedScore: configuration.weightedScore,
      sampleSize: configuration.sampleSize,
      passingCount: configuration.passingCount,
      costUsd: configuration.costUsd,
      errors: configuration.errors,
      skipped: configuration.skipped,
      uncalibrated: configuration.uncalibrated,
      labels,
      frontier: analysis.frontier.includes(configuration.configuration),
      dominatedBy: dominated?.by ?? null,
    });
  }

  return { aggregate, analysis };
}

/* --------------------------------------------------------------- attestation */

/**
 * Records the attestation a gate can consume. A partial (task/config subset) run still
 * records an attestation for reporting, but it is marked `partial` and the autonomy gate
 * ignores it: only the full matrix can unlock autonomy.
 */
export async function attestBenchmarkActivity(args: {
  input: BenchmarkWorkflowInput;
  aggregate: BenchmarkAggregate;
}): Promise<{ attestationId: string | null; reason: string | null }> {
  if (!args.aggregate.calibrationOk) {
    return { attestationId: null, reason: 'uncalibrated' };
  }
  if (!args.aggregate.passed) {
    return { attestationId: null, reason: 'not_passed' };
  }

  const id = `att_${createHash('sha256')
    .update(
      `${args.input.factory}\u0000${args.input.definitionCommit}\u0000${args.input.configHash}`,
    )
    .digest('hex')
    .slice(0, 24)}`;
  const attestation = await recordBenchmarkAttestation(getSql(), {
    id,
    factory: args.input.factory,
    definitionCommit: args.input.definitionCommit,
    suite: args.input.suite,
    configHash: args.input.configHash,
    passRate: args.aggregate.passRate,
    calibrationOk: args.aggregate.calibrationOk,
    passed: args.aggregate.passed,
    partial: !args.input.fullMatrix,
    benchmarkRunId: args.input.benchmarkRunId,
  });
  return {
    attestationId: attestation.id,
    reason: args.input.fullMatrix ? null : 'partial_matrix',
  };
}

/** Reads the run row for diagnostics (the workflow's outcome is derived from the DB). */
export async function getBenchmarkRunActivity(args: {
  benchmarkRunId: string;
}): Promise<BenchmarkRunRecord | null> {
  return await getBenchmarkRun(getSql(), args.benchmarkRunId);
}

/** Convenience for the API: build trial ids/run ids/repo keys for a plan. */
export function planBenchmarkTrials(args: {
  benchmarkRunId: string;
  trials: BenchmarkTrialPlanItem[];
}): BenchmarkTrialPlan[] {
  const configurationIndexes = new Map<string, number>();
  const taskIndexes = new Map<string, number>();

  return args.trials.map((trial, index) => {
    const configurationIndex = configurationIndexes.get(trial.configuration) ?? configurationIndexes.size;
    configurationIndexes.set(trial.configuration, configurationIndex);
    const taskIndex = taskIndexes.get(trial.task) ?? taskIndexes.size;
    taskIndexes.set(trial.task, taskIndex);

    return {
      trialId: `trial_${args.benchmarkRunId}_${index}`,
      configuration: trial.configuration,
      task: trial.task,
      runId: benchmarkTrialRunId(args.benchmarkRunId, configurationIndex, taskIndex),
      prompt: trial.prompt,
      successCriteria: trial.successCriteria,
      startingRepoRefs: trial.startingRepoRefs,
      tags: trial.tags,
      repo: `bench-${args.benchmarkRunId}/trial-${index}`,
      requiresNetwork: trial.tags.some(
        (tag) => tag === 'requires-network' || tag === 'network',
      ),
      replayFrom: trial.replayFrom,
    };
  });
}

export { message as benchmarkErrorMessage, codeOf as benchmarkErrorCode };
