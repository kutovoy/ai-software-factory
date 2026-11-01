import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import {
  aggregateBenchmark,
  analyseBenchmark,
  benchmarkConfigHash,
  findBenchmarkSuite,
  loadBenchmarkSuites,
  paretoFrontier,
  type BenchmarkAggregate,
  type BenchmarkSuiteDescriptor,
  type BenchmarkTrialPlanItem,
  type CostEstimate,
  type ParetoAnalysis,
} from '@factory/evals';
import {
  createBenchmarkRun,
  findBenchmarkAttestation,
  finishBenchmarkRun,
  getBenchmarkRun,
  listBenchmarkAttestations,
  listBenchmarkEvents,
  listBenchmarkResults,
  listBenchmarkRuns,
  listBenchmarkTrials,
  loadDefinition,
  markBenchmarkRunning,
  modelSchema,
  resolveAllGates,
  type BenchmarkAttestationRecord,
  type BenchmarkEventRecord,
  type BenchmarkResultRecord,
  type BenchmarkRunRecord,
  type BenchmarkTrialRecord,
  type FactoryDefinition,
} from '@factory/core';
import {
  estimateBenchmarkCostActivity,
  getSql,
  startBenchmarkWorkflow,
  type BenchmarkTrialPlan,
  type BenchmarkWorkflowInput,
} from '@factory/orchestration';
import type { ApiConfig } from './config';
import { toOrchestrationConfig } from './config';
import {
  ApiError,
  benchmarkAttestationMissing,
  benchmarkNotFound,
  benchmarkSuiteNotFound,
  costConfirmationRequired,
  definitionInvalid,
  invalidRequest,
} from './errors';
import { resolveFactoryDir } from './factories';
import { log } from './logger';
import { pinVersion, resolveRunDefaults } from './runs';

/**
 * Benchmark API (Phase 4b, spec `benchmarks`).
 *
 * Reads are projections of the git-backed suite/task files + the benchmark read model.
 * `POST .../run` estimates first, refuses above the threshold without `confirm: true`, and
 * then starts one `BenchmarkWorkflow`. Attestations bind `(factory, definitionCommit,
 * configHash)`; the autonomy gate consumes them (ADR-018).
 */

const HARNESSES = ['opencode', 'claude-code', 'codex', 'gemini', 'generic-cli', 'fake'] as const;
const RUNNERS = ['local-docker', 'local-process', 'fake'] as const;

export const benchmarkRunBodySchema = z
  .object({
    configurations: z.array(z.string().min(1)).min(1).max(6).optional(),
    tasks: z.array(z.string().min(1)).min(1).max(50).optional(),
    /** Estimate only; nothing starts. */
    dryRun: z.boolean().optional(),
    /** Required when the estimate exceeds the configured threshold. */
    confirm: z.boolean().optional(),
    /** Hard cap; remaining trials are skipped with `budget_exhausted`. */
    maxCostUsd: z.number().min(0).max(10_000).optional(),
    harness: z.enum(HARNESSES).optional(),
    model: modelSchema.optional(),
    runner: z.enum(RUNNERS).optional(),
  })
  .strict();

export type BenchmarkRunBody = z.infer<typeof benchmarkRunBodySchema>;

export interface BenchmarkSuiteApiEntry {
  name: string;
  path: string;
  description: string | null;
  agent: string;
  configurations: BenchmarkSuiteDescriptor['configurations'];
  tasks: BenchmarkSuiteDescriptor['tasks'];
  configHash: string;
  trialCount: number;
  /** Passing, calibrated attestation for this exact commit + matrix, if any. */
  attestation: BenchmarkAttestationRecord | null;
}

export interface BenchmarkGateStatus {
  factory: string;
  definitionCommit: string;
  required: boolean;
  satisfied: boolean;
  /** Stable code when required but not satisfied. */
  code: 'benchmark_attestation_missing' | null;
  reason: string | null;
  suites: { suite: string; configHash: string; attestation: BenchmarkAttestationRecord | null }[];
}

export interface BenchmarkSuiteListResponse {
  factory: string;
  /** Display alias from the manifest, falling back to the directory name in the UI. */
  alias: string | null;
  definitionCommit: string;
  definitionDirty: boolean;
  suites: BenchmarkSuiteApiEntry[];
  latestRun: BenchmarkRunRecord | null;
  attestations: BenchmarkAttestationRecord[];
  benchmarkGate: BenchmarkGateStatus;
}

function loadFactory(
  config: ApiConfig,
  factory: string,
): { dir: string; definition: FactoryDefinition; commit: string; dirty: boolean } {
  const dir = resolveFactoryDir(config, factory);
  const { definition, errors } = loadDefinition(dir);
  if (!definition) throw definitionInvalid(factory, errors);
  const { commit, dirty } = pinVersion(dir, factory);
  return { dir, definition, commit, dirty };
}

function suitesOf(definition: FactoryDefinition): BenchmarkSuiteDescriptor[] {
  try {
    return loadBenchmarkSuites(definition);
  } catch (error) {
    if (error instanceof Error && 'code' in error) {
      const code = (error as { code?: string }).code ?? 'invalid_value';
      throw new ApiError(code, 422, error.message, (error as { details?: unknown }).details);
    }
    throw error;
  }
}

/**
 * Computes the gate status for the running version: every declared suite's full matrix is
 * hashed with the current definition commit and looked up in `benchmark_attestations`.
 */
export async function benchmarkGateStatus(
  config: ApiConfig,
  factory: string,
): Promise<BenchmarkGateStatus> {
  const { definition, commit } = loadFactory(config, factory);
  const resolution = resolveAllGates(definition.manifest);
  const sql = getSql();
  const suites = suitesOf(definition);

  const entries: BenchmarkGateStatus['suites'] = [];
  for (const suite of suites) {
    const configHash = benchmarkConfigHash(suite, commit);
    const attestation = await findBenchmarkAttestation(sql, {
      factory,
      definitionCommit: commit,
      configHash,
    });
    entries.push({ suite: suite.name, configHash, attestation });
  }

  const satisfied = entries.some(
    (entry) =>
      entry.attestation?.passed === true &&
      entry.attestation.calibrationOk === true &&
      entry.attestation.partial === false,
  );
  const required = resolution.benchmarkGateRequired;

  return {
    factory,
    definitionCommit: commit,
    required,
    satisfied: !required || satisfied,
    code: required && !satisfied ? 'benchmark_attestation_missing' : null,
    reason:
      required && !satisfied
        ? 'no passing, calibrated benchmark attestation matches the current definition commit and configuration hash'
        : null,
    suites: entries,
  };
}

export async function getBenchmarkSuitesForApi(
  config: ApiConfig,
  factory: string,
): Promise<BenchmarkSuiteListResponse> {
  const { definition, commit, dirty } = loadFactory(config, factory);
  const sql = getSql();
  const suites = suitesOf(definition);

  const entries: BenchmarkSuiteApiEntry[] = [];
  for (const suite of suites) {
    const configHash = benchmarkConfigHash(suite, commit);
    entries.push({
      name: suite.name,
      path: suite.path,
      description: suite.description,
      agent: suite.agent,
      configurations: suite.configurations,
      tasks: suite.tasks,
      configHash,
      trialCount: suite.configurations.length * suite.tasks.length,
      attestation: await findBenchmarkAttestation(sql, {
        factory,
        definitionCommit: commit,
        configHash,
      }),
    });
  }

  const [latest, attestations, gate] = await Promise.all([
    listBenchmarkRuns(sql, { factory, limit: 1 }).then((runs) => runs[0] ?? null),
    listBenchmarkAttestations(sql, { factory, limit: 20 }),
    benchmarkGateStatus(config, factory),
  ]);

  return {
    factory,
    alias: definition.manifest.alias ?? null,
    definitionCommit: commit,
    definitionDirty: dirty,
    suites: entries,
    latestRun: latest,
    attestations,
    benchmarkGate: gate,
  };
}

export interface BenchmarkEstimateResponse {
  factory: string;
  suite: string;
  definitionCommit: string;
  configHash: string;
  configurations: string[];
  tasks: string[];
  trials: number;
  fullMatrix: boolean;
  estimate: CostEstimate;
}

export async function estimateBenchmarkForApi(
  config: ApiConfig,
  factory: string,
  suiteName: string,
  body: BenchmarkRunBody,
): Promise<{
  dir: string;
  definition: FactoryDefinition;
  commit: string;
  dirty: boolean;
  suite: BenchmarkSuiteDescriptor;
  configHash: string;
  plan: BenchmarkTrialPlanItem[];
  fullMatrix: boolean;
  estimate: CostEstimate;
}> {
  const { dir, definition, commit, dirty } = loadFactory(config, factory);
  const suite = findBenchmarkSuite(suitesOf(definition), suiteName);
  if (!suite) throw benchmarkSuiteNotFound(factory, suiteName);

  // The activity is the single estimator (median comparable run cost + threshold), shared
  // with the workflow and the tests.
  let estimated;
  try {
    estimated = await estimateBenchmarkCostActivity({
      factory,
      factoryRoot: dir,
      suite: suiteName,
      definitionCommit: commit,
      ...(body.configurations ? { configurations: body.configurations } : {}),
      ...(body.tasks ? { tasks: body.tasks } : {}),
      defaultRunCostUsd: config.benchmarkDefaultRunCostUsd,
      thresholdUsd: config.benchmarkConfirmThresholdUsd,
    });
  } catch (error) {
    if (error instanceof Error && 'type' in error) {
      const code = (error as { type?: string }).type ?? 'invalid_matrix';
      throw new ApiError(code, 422, error.message, (error as { details?: unknown }).details);
    }
    throw error;
  }

  return {
    dir,
    definition,
    commit,
    dirty,
    suite,
    configHash: estimated.configHash,
    plan: estimated.trials,
    fullMatrix: estimated.fullMatrix,
    estimate: estimated.estimate,
  };
}

export interface StartedBenchmarkResponse {
  factory: string;
  suite: string;
  benchmark: BenchmarkRunRecord;
  estimate: CostEstimate;
  workflow: { workflowId: string; temporalRunId: string };
  trials: number;
}

export async function startBenchmarkForApi(
  config: ApiConfig,
  factory: string,
  suiteName: string,
  body: BenchmarkRunBody,
): Promise<StartedBenchmarkResponse | BenchmarkEstimateResponse> {
  const resolved = await estimateBenchmarkForApi(config, factory, suiteName, body);

  const estimateResponse: BenchmarkEstimateResponse = {
    factory,
    suite: resolved.suite.name,
    definitionCommit: resolved.commit,
    configHash: resolved.configHash,
    configurations: [...new Set(resolved.plan.map((trial) => trial.configuration))],
    tasks: [...new Set(resolved.plan.map((trial) => trial.task))],
    trials: resolved.plan.length,
    fullMatrix: resolved.fullMatrix,
    estimate: resolved.estimate,
  };

  if (body.dryRun) return estimateResponse;

  if (resolved.estimate.requiresConfirmation && body.confirm !== true) {
    throw costConfirmationRequired(resolved.estimate);
  }

  const maxCostUsd = Math.min(
    body.maxCostUsd ?? config.benchmarkMaxCostUsd,
    config.benchmarkMaxCostUsd,
  );
  if (body.maxCostUsd !== undefined && body.maxCostUsd <= 0 && resolved.estimate.estimateUsd > 0) {
    throw invalidRequest('maxCostUsd must be positive; a zero cap would skip every trial', {
      maxCostUsd: body.maxCostUsd,
    });
  }

  const benchmarkRunId = `bench_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`;
  const workflowId = `benchmark-${benchmarkRunId}`;
  const plan: BenchmarkTrialPlan[] = planTrials(benchmarkRunId, resolved.plan);

  const defaults = resolveRunDefaults(resolved.definition.manifest, {
    ...(body.harness
      ? { harness: body.harness }
      : config.benchmarkHarness
        ? { harness: config.benchmarkHarness }
        : {}),
    ...(body.model ? { model: body.model } : {}),
    ...(body.runner
      ? { runner: body.runner }
      : config.benchmarkRunner
        ? { runner: config.benchmarkRunner }
        : {}),
  });

  const sql = getSql();
  const run = await createBenchmarkRun(sql, {
    id: benchmarkRunId,
    factory,
    suite: resolved.suite.name,
    definitionCommit: resolved.commit,
    configHash: resolved.configHash,
    tasks: estimateResponse.tasks,
    configurations: estimateResponse.configurations,
    matrix: plan.map((trial) => ({ configuration: trial.configuration, task: trial.task })),
    estimateUsd: resolved.estimate.estimateUsd,
    maxCostUsd,
    partial: !resolved.fullMatrix,
    workflowId,
  });

  const input: BenchmarkWorkflowInput = {
    benchmarkRunId,
    factory,
    factoryRoot: resolved.dir,
    repoRoot: config.repoRoot,
    suite: resolved.suite.name,
    definitionCommit: resolved.commit,
    definitionDirty: resolved.dirty,
    configHash: resolved.configHash,
    trials: plan,
    harness: defaults.harness,
    ...(defaults.model ? { model: defaults.model } : {}),
    runner: defaults.runner,
    concurrency: config.benchmarkConcurrency,
    estimateUsd: resolved.estimate.estimateUsd,
    maxCostUsd,
    passThreshold: config.benchmarkPassThreshold,
    fullMatrix: resolved.fullMatrix,
    judgeMode: config.scoringJudgeMode,
    permissionTimeoutMs: config.permissionTimeoutMs,
  };

  const workflow = await startBenchmarkWorkflow(input, toOrchestrationConfig(config)).catch(
    async (error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error);
      await finishBenchmarkRun(sql, {
        id: benchmarkRunId,
        status: 'error',
        spentUsd: 0,
        budgetExhausted: false,
        error: `orchestrator_unavailable: ${detail}`,
      }).catch(() => undefined);
      log('error', 'benchmark_start_failed', { factory, suite: resolved.suite.name, detail });
      throw new ApiError('orchestrator_unavailable', 503, 'could not start the benchmark workflow', {
        benchmarkRunId,
        error: detail,
      });
    },
  );

  await markBenchmarkRunning(sql, {
    id: benchmarkRunId,
    workflowId: workflow.workflowId,
    temporalRunId: workflow.temporalRunId,
  });

  log('info', 'benchmark_started', {
    benchmarkRunId,
    factory,
    suite: resolved.suite.name,
    trials: plan.length,
    estimateUsd: resolved.estimate.estimateUsd,
    maxCostUsd,
  });

  return {
    factory,
    suite: resolved.suite.name,
    benchmark: (await getBenchmarkRun(sql, benchmarkRunId)) ?? run,
    estimate: resolved.estimate,
    workflow,
    trials: plan.length,
  };
}

function planTrials(
  benchmarkRunId: string,
  trials: BenchmarkTrialPlanItem[],
): BenchmarkTrialPlan[] {
  const configurationIndexes = new Map<string, number>();
  const taskIndexes = new Map<string, number>();

  return trials.map((trial, index) => {
    const configurationIndex =
      configurationIndexes.get(trial.configuration) ?? configurationIndexes.size;
    configurationIndexes.set(trial.configuration, configurationIndex);
    const taskIndex = taskIndexes.get(trial.task) ?? taskIndexes.size;
    taskIndexes.set(trial.task, taskIndex);

    return {
      trialId: `trial_${benchmarkRunId}_${index}`,
      configuration: trial.configuration,
      task: trial.task,
      runId: `run_bench_${benchmarkRunId.replace(/^bench_/, '')}_${configurationIndex}_${taskIndex}`,
      prompt: trial.prompt,
      successCriteria: trial.successCriteria,
      startingRepoRefs: trial.startingRepoRefs,
      tags: trial.tags,
      repo: `bench-${benchmarkRunId}/trial-${index}`,
      requiresNetwork: trial.tags.some(
        (tag) => tag === 'requires-network' || tag === 'network',
      ),
      replayFrom: trial.replayFrom,
    };
  });
}

export interface BenchmarkRunDetailResponse {
  benchmark: BenchmarkRunRecord;
  trials: BenchmarkTrialRecord[];
  results: BenchmarkResultRecord[];
  events: BenchmarkEventRecord[];
  aggregate: BenchmarkAggregate;
  frontier: string[];
  labels: ParetoAnalysis['labels'];
  dominated: ParetoAnalysis['dominated'];
  recommendation: ParetoAnalysis['recommendation'];
  recommendationReason: string | null;
  attestation: BenchmarkAttestationRecord | null;
}

export async function getBenchmarkRunForApi(id: string): Promise<BenchmarkRunDetailResponse> {
  const sql = getSql();
  const run = await getBenchmarkRun(sql, id);
  if (!run) throw benchmarkNotFound(id);

  const [trials, results, events, attestation] = await Promise.all([
    listBenchmarkTrials(sql, id),
    listBenchmarkResults(sql, id),
    listBenchmarkEvents(sql, id),
    findBenchmarkAttestation(sql, {
      factory: run.factory,
      definitionCommit: run.definitionCommit,
      configHash: run.configHash,
    }),
  ]);

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
  );
  // The persisted run verdict is authoritative (it was computed with the run's threshold).
  aggregate.passed = run.passed;
  aggregate.calibrationOk = run.calibrationOk;
  aggregate.uncalibrated = !run.calibrationOk;
  const analysis = results.length
    ? paretoFrontier(
        results.map((result) => ({
          configuration: result.configuration,
          passRate: result.passRate,
          costUsd: result.costUsd,
        })),
      )
    : analyseBenchmark(aggregate);

  return {
    benchmark: run,
    trials,
    results,
    events,
    aggregate,
    frontier: analysis.frontier,
    labels: analysis.labels,
    dominated: analysis.dominated,
    recommendation: analysis.recommendation,
    recommendationReason: analysis.reason,
    attestation,
  };
}

export interface AttestationsResponse {
  factory: string;
  definitionCommit: string;
  attestations: BenchmarkAttestationRecord[];
  benchmarkGate: BenchmarkGateStatus;
}

export async function listAttestationsForApi(
  config: ApiConfig,
  factory: string,
): Promise<AttestationsResponse> {
  const { commit } = loadFactory(config, factory);
  const sql = getSql();
  const [attestations, gate] = await Promise.all([
    listBenchmarkAttestations(sql, { factory, limit: 50 }),
    benchmarkGateStatus(config, factory),
  ]);
  return { factory, definitionCommit: commit, attestations, benchmarkGate: gate };
}

/** Shared by the autonomy route: throws `benchmark_attestation_missing` when unresolved. */
export function assertBenchmarkGateSatisfied(
  gate: BenchmarkGateStatus,
  options: { override?: boolean } = {},
): void {
  if (!gate.required || gate.satisfied || options.override) return;
  throw benchmarkAttestationMissing(gate.factory, gate.definitionCommit, gate.suites);
}
