import { createHash } from 'node:crypto';
import type { BenchmarkSuite, FactoryDefinition } from '@factory/core';

/**
 * Benchmarks (Phase 4b).
 *
 * A suite is a (task × configuration) matrix loaded from the git-backed definition. The
 * matrix is hashed together with the definition commit: an attestation binds that hash, so
 * changing a configuration (or the definition) invalidates it.
 *
 * Everything here is pure data: no DB, no Temporal, no model. The API, the workflow and the
 * unit tests share the same arithmetic.
 */

/** The supported maximum; the schema also enforces it with `too_many_configurations`. */
export const MAX_BENCHMARK_CONFIGURATIONS = 6;

/** A benchmark passes when its calibrated pass rate reaches this threshold. */
export const DEFAULT_BENCHMARK_PASS_THRESHOLD = 0.8;

export type BenchmarkErrorCode =
  | 'invalid_sha'
  | 'too_many_configurations'
  | 'duplicate_tasks'
  | 'duplicate_configurations'
  | 'benchmark_task_mismatch'
  | 'invalid_matrix'
  | 'invalid_replay_source';

export class BenchmarkError extends Error {
  readonly code: BenchmarkErrorCode;
  readonly details?: unknown;

  constructor(code: BenchmarkErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'BenchmarkError';
    this.code = code;
    this.details = details;
  }
}

/* ------------------------------------------------------------------ shapes */

export interface BenchmarkConfigurationDescriptor {
  name: string;
  agents: { agent: string; model?: string; harness?: string }[];
}

export interface BenchmarkTaskDescriptor {
  slug: string;
  path: string;
  title: string;
  prompt: string;
  successCriteria: string;
  startingRepoRefs: string[];
  tags: string[];
  sourceRunId: string | null;
  /**
   * Recorded run this task replays (`runs/<replayFrom>/events.jsonl` + `patch.diff`).
   * A replay trial is scored without a model call (spec `benchmark-replay`).
   */
  replayFrom: string | null;
}

export interface BenchmarkSuiteDescriptor {
  name: string;
  path: string;
  description: string | null;
  agent: string;
  configurations: BenchmarkConfigurationDescriptor[];
  tasks: BenchmarkTaskDescriptor[];
}

export interface NormalizedBenchmarkMatrix {
  suite: string;
  agent: string;
  configurations: BenchmarkConfigurationDescriptor[];
  tasks: string[];
}

export interface BenchmarkTrialPlanItem {
  configuration: string;
  task: string;
  prompt: string;
  successCriteria: string;
  startingRepoRefs: string[];
  tags: string[];
  /** Set when the task replays a recorded run; the trial then calls no model. */
  replayFrom: string | null;
}

/* --------------------------------------------------------------- validation */

const FULL_SHA_RE = /^[a-z0-9.-]+\.[a-z]{2,}:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[0-9a-f]{40}$/;

/** A run id (`run_<ulid>`, `run_bench_…`, `run_<ulid>_<stage>_<n>`) is the replay source. */
const RUN_ID_RE = /^run_[A-Za-z0-9_-]+$/;

function assertFullShas(task: BenchmarkTaskDescriptor): void {
  if (task.startingRepoRefs.length === 0) {
    throw new BenchmarkError(
      'invalid_sha',
      `task "${task.slug}" declares no startingRepoRefs; pin at least one full 40-char commit SHA`,
      { task: task.slug },
    );
  }
  for (const ref of task.startingRepoRefs) {
    if (!FULL_SHA_RE.test(ref)) {
      throw new BenchmarkError(
        'invalid_sha',
        `task "${task.slug}" has a startingRepoRef that is not host:owner/name@<40-char SHA>: ${ref}`,
        { task: task.slug, ref },
      );
    }
  }
}

/**
 * A replay source must name a run id: the recording is read from `runs/<id>/`. The directory
 * is checked at trial start (missing → `replay_missing`), not here — validation must stay
 * pure so a definition can be validated without the run store.
 */
function assertReplaySource(task: BenchmarkTaskDescriptor): void {
  if (task.replayFrom === null) return;
  if (!RUN_ID_RE.test(task.replayFrom)) {
    throw new BenchmarkError(
      'invalid_replay_source',
      `task "${task.slug}" declares replayFrom "${task.replayFrom}" but it is not a run id (run_…)`,
      { task: task.slug, replayFrom: task.replayFrom },
    );
  }
}

/**
 * Validates a suite against its task files. Codes are stable so the API and CLI can branch
 * on them without parsing prose.
 */
export function validateBenchmarkSuite(
  suite: BenchmarkSuite,
  tasks: BenchmarkTaskDescriptor[],
): void {
  if (suite.configurations.length > MAX_BENCHMARK_CONFIGURATIONS) {
    throw new BenchmarkError(
      'too_many_configurations',
      `suite "${suite.name}" declares ${suite.configurations.length} configurations; the supported maximum is ${MAX_BENCHMARK_CONFIGURATIONS}`,
      { suite: suite.name, configurations: suite.configurations.length, max: MAX_BENCHMARK_CONFIGURATIONS },
    );
  }

  const configurationNames = suite.configurations.map((configuration) => configuration.name);
  if (new Set(configurationNames).size !== configurationNames.length) {
    throw new BenchmarkError(
      'duplicate_configurations',
      `suite "${suite.name}" declares duplicate configuration names`,
      { suite: suite.name, configurations: configurationNames },
    );
  }

  if (new Set(suite.tasks).size !== suite.tasks.length) {
    throw new BenchmarkError(
      'duplicate_tasks',
      `suite "${suite.name}" lists a task more than once; every task file is used exactly once`,
      { suite: suite.name, tasks: suite.tasks },
    );
  }

  const bySlug = new Map(tasks.map((task) => [task.slug, task]));
  for (const slug of suite.tasks) {
    if (!bySlug.has(slug)) {
      throw new BenchmarkError(
        'benchmark_task_mismatch',
        `suite "${suite.name}" lists task "${slug}" but no benchmarks/${suite.name}/tasks/${slug}.yaml exists`,
        { suite: suite.name, task: slug },
      );
    }
  }
  for (const task of tasks) {
    if (!suite.tasks.includes(task.slug)) {
      throw new BenchmarkError(
        'benchmark_task_mismatch',
        `task "${task.slug}" exists but is not listed in suite "${suite.name}"`,
        { suite: suite.name, task: task.slug },
      );
    }
    assertFullShas(task);
    assertReplaySource(task);
  }
}

/* ------------------------------------------------------------------- loader */

function taskDescriptor(resource: {
  name: string;
  path: string;
  doc: unknown;
}): BenchmarkTaskDescriptor {
  const doc = resource.doc as {
    title: string;
    prompt: string;
    successCriteria: string;
    startingRepoRefs: string[];
    tags?: string[];
    sourceRunId?: string;
    replayFrom?: string;
  };
  return {
    slug: resource.name.split('/').slice(1).join('/'),
    path: resource.path,
    title: doc.title,
    prompt: doc.prompt,
    successCriteria: doc.successCriteria,
    startingRepoRefs: [...doc.startingRepoRefs],
    tags: [...(doc.tags ?? [])],
    sourceRunId: doc.sourceRunId ?? null,
    replayFrom: doc.replayFrom ?? null,
  };
}

/** Loads every benchmark suite and its task files from a validated definition. */
export function loadBenchmarkSuites(definition: FactoryDefinition): BenchmarkSuiteDescriptor[] {
  const suites = definition.resources
    .filter((resource) => resource.kind === 'benchmark')
    .map((resource) => ({ resource, doc: resource.doc as BenchmarkSuite }))
    .sort((left, right) => left.resource.name.localeCompare(right.resource.name));

  return suites.map(({ resource, doc }) => {
    const prefix = `benchmarks/${resource.name}/tasks/`;
    const tasks = definition.resources
      .filter((candidate) => candidate.kind === 'benchmark-task')
      .filter((candidate) => candidate.path.startsWith(prefix))
      .map((candidate) => taskDescriptor(candidate))
      .sort((left, right) => left.slug.localeCompare(right.slug));

    validateBenchmarkSuite(doc, tasks);

    return {
      name: resource.name,
      path: resource.path,
      description: doc.description ?? null,
      agent: doc.agent,
      configurations: doc.configurations.map((configuration) => ({
        name: configuration.name,
        agents: (configuration.agents ?? []).map((pin) => ({
          agent: pin.agent,
          ...(pin.model ? { model: pin.model } : {}),
          ...(pin.harness?.type ? { harness: pin.harness.type } : {}),
        })),
      })),
      tasks,
    };
  });
}

export function findBenchmarkSuite(
  suites: BenchmarkSuiteDescriptor[],
  name: string,
): BenchmarkSuiteDescriptor | null {
  return suites.find((suite) => suite.name === name) ?? null;
}

/* -------------------------------------------------------------- matrix/hash */

/** Normalises a suite for hashing: configuration order and task order do not matter. */
export function normalizeBenchmarkMatrix(suite: BenchmarkSuiteDescriptor): NormalizedBenchmarkMatrix {
  return {
    suite: suite.name,
    agent: suite.agent,
    configurations: suite.configurations
      .map((configuration) => ({
        name: configuration.name,
        agents: [...configuration.agents]
          .map((pin) => ({
            agent: pin.agent,
            ...(pin.model ? { model: pin.model } : {}),
            ...(pin.harness ? { harness: pin.harness } : {}),
          }))
          .sort((left, right) =>
            `${left.agent}\u0000${left.model ?? ''}\u0000${left.harness ?? ''}`.localeCompare(
              `${right.agent}\u0000${right.model ?? ''}\u0000${right.harness ?? ''}`,
            ),
          ),
      }))
      .sort((left, right) => left.name.localeCompare(right.name)),
    tasks: [...suite.tasks.map((task) => task.slug)].sort(),
  };
}

/**
 * `configHash = sha256(normalized matrix + definitionCommit)`. Attestations bind to it, so
 * changing a configuration or the definition invalidates the previous attestation.
 */
export function benchmarkConfigHash(
  suite: BenchmarkSuiteDescriptor,
  definitionCommit: string,
): string {
  return createHash('sha256')
    .update(JSON.stringify({ definitionCommit, matrix: normalizeBenchmarkMatrix(suite) }))
    .digest('hex');
}

export interface BuildMatrixOptions {
  configurations?: string[];
  tasks?: string[];
}

/**
 * Builds the trial list for a (possibly partial) run. A partial run is still bound to the
 * full matrix hash: attestation requires the full matrix to have been executed.
 */
export function buildBenchmarkTrials(
  suite: BenchmarkSuiteDescriptor,
  options: BuildMatrixOptions = {},
): BenchmarkTrialPlanItem[] {
  const configurationNames = options.configurations ?? suite.configurations.map((c) => c.name);
  const taskSlugs = options.tasks ?? suite.tasks.map((task) => task.slug);

  for (const name of configurationNames) {
    if (!suite.configurations.some((configuration) => configuration.name === name)) {
      throw new BenchmarkError(
        'invalid_matrix',
        `configuration "${name}" is not declared by suite "${suite.name}"`,
        { suite: suite.name, configuration: name, available: suite.configurations.map((c) => c.name) },
      );
    }
  }
  for (const slug of taskSlugs) {
    if (!suite.tasks.some((task) => task.slug === slug)) {
      throw new BenchmarkError(
        'invalid_matrix',
        `task "${slug}" is not declared by suite "${suite.name}"`,
        { suite: suite.name, task: slug, available: suite.tasks.map((task) => task.slug) },
      );
    }
  }
  if (configurationNames.length === 0 || taskSlugs.length === 0) {
    throw new BenchmarkError(
      'invalid_matrix',
      `suite "${suite.name}" needs at least one configuration and one task`,
      { suite: suite.name },
    );
  }

  const configurations = [...new Set(configurationNames)];
  const tasks = [...new Set(taskSlugs)];
  const trials: BenchmarkTrialPlanItem[] = [];

  for (const configuration of configurations) {
    for (const slug of tasks) {
      const task = suite.tasks.find((candidate) => candidate.slug === slug) as BenchmarkTaskDescriptor;
      trials.push({
        configuration,
        task: slug,
        prompt: task.prompt,
        successCriteria: task.successCriteria,
        startingRepoRefs: [...task.startingRepoRefs],
        tags: [...task.tags],
        replayFrom: task.replayFrom,
      });
    }
  }

  return trials;
}

export function isFullMatrix(
  suite: BenchmarkSuiteDescriptor,
  options: BuildMatrixOptions,
): boolean {
  const configurations = new Set(options.configurations ?? suite.configurations.map((c) => c.name));
  const tasks = new Set(options.tasks ?? suite.tasks.map((task) => task.slug));
  return (
    configurations.size === suite.configurations.length &&
    tasks.size === suite.tasks.length
  );
}

/* ------------------------------------------------------------- cost estimate */

export interface CostEstimate {
  trials: number;
  medianRunCostUsd: number;
  estimateUsd: number;
  thresholdUsd: number;
  requiresConfirmation: boolean;
}

/** Median of the comparable run costs, or the configured fallback when there is no data. */
export function medianRunCost(costs: number[], fallbackUsd: number): number {
  const usable = costs.filter((cost) => Number.isFinite(cost) && cost >= 0).sort((a, b) => a - b);
  if (usable.length === 0) return fallbackUsd;
  const middle = Math.floor(usable.length / 2);
  return usable.length % 2 === 1
    ? (usable[middle] as number)
    : ((usable[middle - 1] as number) + (usable[middle] as number)) / 2;
}

/**
 * Estimate = trials × median comparable run cost. Above `thresholdUsd` an explicit
 * `confirm: true` is required; the estimate is never a hard cap on its own.
 */
export function estimateBenchmarkCost(args: {
  trials: number;
  comparableRunCosts: number[];
  fallbackRunCostUsd: number;
  thresholdUsd: number;
}): CostEstimate {
  const medianRunCostUsd = medianRunCost(args.comparableRunCosts, args.fallbackRunCostUsd);
  const estimateUsd = roundUsd(args.trials * medianRunCostUsd);
  return {
    trials: args.trials,
    medianRunCostUsd: roundUsd(medianRunCostUsd),
    estimateUsd,
    thresholdUsd: args.thresholdUsd,
    requiresConfirmation: estimateUsd > args.thresholdUsd,
  };
}

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

/* ---------------------------------------------------------------- aggregation */

export type BenchmarkTrialStatus = 'ok' | 'error' | 'skipped';

export interface BenchmarkTrialResultLike {
  configuration: string;
  task: string;
  status: BenchmarkTrialStatus;
  errorCode?: string | null;
  score: number | null;
  passing: boolean;
  costUsd: number;
  uncalibrated: boolean;
}

export interface BenchmarkConfigurationAggregate {
  configuration: string;
  passRate: number | null;
  weightedScore: number | null;
  sampleSize: number;
  passingCount: number;
  costUsd: number;
  errors: number;
  skipped: number;
  uncalibrated: boolean;
}

export interface BenchmarkAggregate {
  configurations: BenchmarkConfigurationAggregate[];
  sampleSize: number;
  passingCount: number;
  passRate: number | null;
  weightedScore: number | null;
  costUsd: number;
  errors: number;
  skipped: number;
  uncalibrated: boolean;
  calibrationOk: boolean;
  passed: boolean;
  threshold: number;
}

/**
 * Per-configuration pass rate / weighted score / cost, plus the overall verdict.
 * Only `ok` trials are samples; `error` and `skipped` trials are reported, never hidden.
 */
export function aggregateBenchmark(
  trials: BenchmarkTrialResultLike[],
  options: { passThreshold?: number } = {},
): BenchmarkAggregate {
  const threshold = options.passThreshold ?? DEFAULT_BENCHMARK_PASS_THRESHOLD;
  const byConfiguration = new Map<string, BenchmarkTrialResultLike[]>();

  for (const trial of trials) {
    const bucket = byConfiguration.get(trial.configuration);
    if (bucket) bucket.push(trial);
    else byConfiguration.set(trial.configuration, [trial]);
  }

  const configurations: BenchmarkConfigurationAggregate[] = [...byConfiguration.entries()]
    .map(([configuration, rows]) => {
      const ok = rows.filter((row) => row.status === 'ok');
      const scored = ok.filter((row) => row.score !== null);
      const passing = ok.filter((row) => row.passing).length;
      return {
        configuration,
        passRate: ok.length === 0 ? null : passing / ok.length,
        weightedScore:
          scored.length === 0
            ? null
            : scored.reduce((total, row) => total + (row.score ?? 0), 0) / scored.length,
        sampleSize: ok.length,
        passingCount: passing,
        costUsd: roundUsd(rows.reduce((total, row) => total + (row.costUsd ?? 0), 0)),
        errors: rows.filter((row) => row.status === 'error').length,
        skipped: rows.filter((row) => row.status === 'skipped').length,
        uncalibrated: ok.some((row) => row.uncalibrated),
      } satisfies BenchmarkConfigurationAggregate;
    })
    .sort((left, right) => left.configuration.localeCompare(right.configuration));

  const ok = trials.filter((trial) => trial.status === 'ok');
  const scored = ok.filter((trial) => trial.score !== null);
  const passing = ok.filter((trial) => trial.passing).length;
  const uncalibrated = configurations.some((configuration) => configuration.uncalibrated);
  const passRate = ok.length === 0 ? null : passing / ok.length;

  return {
    configurations,
    sampleSize: ok.length,
    passingCount: passing,
    passRate,
    weightedScore:
      scored.length === 0
        ? null
        : scored.reduce((total, trial) => total + (trial.score ?? 0), 0) / scored.length,
    costUsd: roundUsd(trials.reduce((total, trial) => total + (trial.costUsd ?? 0), 0)),
    errors: trials.filter((trial) => trial.status === 'error').length,
    skipped: trials.filter((trial) => trial.status === 'skipped').length,
    uncalibrated,
    calibrationOk: !uncalibrated,
    passed: !uncalibrated && passRate !== null && ok.length > 0 && passRate >= threshold,
    threshold,
  };
}

/* --------------------------------------------------------------- Pareto */

export interface ParetoPoint {
  configuration: string;
  passRate: number | null;
  costUsd: number;
}

export type BenchmarkLabel = 'highest_performance' | 'most_efficient' | 'lowest_cost';

export interface ParetoAnalysis {
  frontier: string[];
  labels: Record<BenchmarkLabel, string | null>;
  dominated: { configuration: string; by: string }[];
  recommendation: { configuration: string; reason: 'dominance' | 'only_configuration' } | null;
  reason: string | null;
}

function dominates(left: ParetoPoint, right: ParetoPoint): boolean {
  const leftRate = left.passRate ?? 0;
  const rightRate = right.passRate ?? 0;
  const atLeastAsGood = leftRate >= rightRate && left.costUsd <= right.costUsd;
  const strictlyBetter = leftRate > rightRate || left.costUsd < right.costUsd;
  return atLeastAsGood && strictlyBetter;
}

/**
 * Pareto, not a single score: report the non-dominated configurations on
 * (pass rate, cost) and label the notable ones. A single recommendation exists only when
 * one configuration dominates every other one.
 */
export function paretoFrontier(points: ParetoPoint[]): ParetoAnalysis {
  const eligible = points.filter(
    (point): point is ParetoPoint & { passRate: number } =>
      point.passRate !== null && Number.isFinite(point.passRate),
  );

  if (eligible.length === 0) {
    return {
      frontier: [],
      labels: { highest_performance: null, most_efficient: null, lowest_cost: null },
      dominated: [],
      recommendation: null,
      reason: 'no_samples',
    };
  }

  const dominated: { configuration: string; by: string }[] = [];
  const frontier: string[] = [];

  for (const point of eligible) {
    const dominator = eligible.find(
      (candidate) => candidate.configuration !== point.configuration && dominates(candidate, point),
    );
    if (dominator) dominated.push({ configuration: point.configuration, by: dominator.configuration });
    else frontier.push(point.configuration);
  }

  const byPerformance = [...eligible].sort(
    (left, right) => right.passRate - left.passRate || left.costUsd - right.costUsd,
  )[0] as ParetoPoint & { passRate: number };
  const byCost = [...eligible].sort(
    (left, right) => left.costUsd - right.costUsd || right.passRate - left.passRate,
  )[0] as ParetoPoint & { passRate: number };
  const byEfficiency = [...eligible].sort((left, right) => {
    const ratio = (point: ParetoPoint & { passRate: number }): number =>
      point.costUsd === 0 ? Number.POSITIVE_INFINITY : point.passRate / point.costUsd;
    const delta = ratio(right) - ratio(left);
    if (delta !== 0) return delta;
    return right.passRate - left.passRate || left.costUsd - right.costUsd;
  })[0] as ParetoPoint & { passRate: number };

  let recommendation: ParetoAnalysis['recommendation'] = null;
  let reason: string | null = null;

  if (eligible.length === 1) {
    recommendation = { configuration: eligible[0]!.configuration, reason: 'only_configuration' };
  } else {
    const soleDominator = eligible.find((candidate) =>
      eligible.every(
        (other) => other.configuration === candidate.configuration || dominates(candidate, other),
      ),
    );
    if (soleDominator) {
      recommendation = { configuration: soleDominator.configuration, reason: 'dominance' };
    } else {
      reason = 'pareto_frontier';
    }
  }

  return {
    frontier: frontier.sort(),
    labels: {
      highest_performance: byPerformance.configuration,
      most_efficient: byEfficiency.configuration,
      lowest_cost: byCost.configuration,
    },
    dominated,
    recommendation,
    reason,
  };
}

/** Convenience: aggregate → points → frontier. */
export function analyseBenchmark(aggregate: BenchmarkAggregate): ParetoAnalysis {
  return paretoFrontier(
    aggregate.configurations.map((configuration) => ({
      configuration: configuration.configuration,
      passRate: configuration.passRate,
      costUsd: configuration.costUsd,
    })),
  );
}
