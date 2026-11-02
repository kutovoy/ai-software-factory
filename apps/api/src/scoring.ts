import { z } from 'zod';
import {
  addCalibrationItem,
  aggregateScores,
  computeFactoryMetrics,
  countJudgeScoresToday,
  createCalibrationSet,
  getScore,
  latestCalibrationResult,
  listCalibrationItems,
  listCalibrationResults,
  listCalibrationSets,
  listScores,
  loadDefinition,
  MetricsWindowError,
  parseMetricsWindow,
  recordCalibrationResult,
  resolveAllGates,
  upsertScorerDefinition,
  type CalibrationItemRecord,
  type CalibrationResultRecord,
  type FactoryDefinition,
  type ScoreAggregate,
  type ScoreEventRecord,
  type ScoreRecord,
} from '@factory/core';
import {
  DEFAULT_CALIBRATION_MIN_SIZE,
  DEFAULT_CALIBRATION_THRESHOLD,
  DEFAULT_CALIBRATION_TOLERANCE,
  JudgeError,
  computeCalibration,
  createJudgeClient,
  findScorer,
  loadScorerRegistry,
  runJudgeScorer,
  type CalibrationItemObservation,
  type ScorerRegistryEntry,
} from '@factory/evals';
import {
  buildRunContext,
  getRun,
  getSql,
  startScoringWorkflow,
  type StartedScoring,
} from '@factory/orchestration';
import type { ApiConfig } from './config';
import { toOrchestrationConfig } from './config';
import { definitionInvalid, invalidRequest, runNotFound, scoreNotFound, ApiError } from './errors';
import { resolveFactoryDir } from './factories';
import { log } from './logger';

/**
 * Scoring and metrics API (spec `measurement`).
 *
 * Reads are projections of the definition (git) + the scoring read model (Postgres).
 * `POST /scoring` starts the ScoringWorkflow; `POST /calibration` runs a golden-set
 * calibration synchronously (small sets, stub judge in CI).
 */

const LOOP_STAGES = ['triage', 'spec', 'plan', 'implement', 'review', 'verify', 'ship'] as const;

export const scoringBodySchema = z
  .object({
    factory: z.string().min(1),
    runId: z.string().min(1).optional(),
    workItemId: z.string().min(1).optional(),
    stage: z.enum(LOOP_STAGES).optional(),
    windowDays: z.number().int().min(1).max(90).optional(),
    force: z.boolean().optional(),
  })
  .strict();

export type ScoringBody = z.infer<typeof scoringBodySchema>;

export const calibrationItemSchema = z
  .object({
    runId: z.string().min(1),
    humanLabel: z.string().min(1),
    humanScore: z.number().min(0).max(1).optional(),
    notes: z.string().max(2000).optional(),
  })
  .strict();

export const calibrationBodySchema = z
  .object({
    factory: z.string().min(1),
    scorer: z.string().min(1),
    name: z.string().min(1).max(120).optional(),
    /** Re-run an existing set instead of creating a new one. */
    setId: z.string().min(1).optional(),
    items: z.array(calibrationItemSchema).min(1).max(200).optional(),
    minSize: z.number().int().min(1).max(200).optional(),
    threshold: z.number().min(0).max(1).optional(),
    tolerance: z.number().min(0).max(1).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!value.setId && !value.items) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'provide either `items` (new set) or `setId` (existing set)',
        path: ['items'],
      });
    }
  });

export type CalibrationBody = z.infer<typeof calibrationBodySchema>;

function loadFactory(config: ApiConfig, factory: string): { dir: string; definition: FactoryDefinition } {
  const dir = resolveFactoryDir(config, factory);
  const { definition, errors } = loadDefinition(dir, { requireFactoryId: true });
  if (!definition) throw definitionInvalid(factory, errors);
  return { dir, definition };
}

function registryOf(config: ApiConfig, factory: string): {
  dir: string;
  definition: FactoryDefinition;
  registry: ScorerRegistryEntry[];
} {
  const { dir, definition } = loadFactory(config, factory);
  return { dir, definition, registry: loadScorerRegistry(definition) };
}

/* ---------------------------------------------------------------- scorers */

export interface ScorerApiEntry extends ScorerRegistryEntry {
  /** Wire alias for `scorerClass` (the spec calls it `class`). */
  class: 'deterministic' | 'judge';
  calibration: {
    required: boolean;
    calibrated: boolean;
    latest: CalibrationResultRecord | null;
  };
}

export interface ScorersResponse {
  factory: string;
  scorers: ScorerApiEntry[];
  budget: { maxPerDay: number; usedToday: number; remaining: number };
  benchmarkGate: { required: boolean; satisfied: boolean; reason: string | null };
}

export async function getScorersForApi(
  config: ApiConfig,
  factory: string,
): Promise<ScorersResponse> {
  const { definition, registry } = registryOf(config, factory);
  const sql = getSql();

  for (const scorer of registry) {
    await upsertScorerDefinition(sql, {
      factory,
      name: scorer.name,
      scorerClass: scorer.scorerClass,
      rubricHash: scorer.rubricHash,
      judgeModel: scorer.judgeModel,
      labels: scorer.labels,
      passingScore: scorer.passingScore,
      samplingRate: scorer.samplingRate,
      selfImprovement: scorer.selfImprovement,
      checks: scorer.checks,
      body: scorer.body,
    });
  }

  const [usedToday, results] = await Promise.all([
    countJudgeScoresToday(sql, factory),
    listCalibrationResults(sql, { factory, limit: 200 }),
  ]);

  const scorers: ScorerApiEntry[] = registry.map((scorer) => {
    const latest =
      results.find(
        (result) =>
          result.scorer === scorer.name &&
          result.rubricHash === scorer.rubricHash &&
          result.judgeModel === scorer.judgeModel,
      ) ?? null;
    return {
      ...scorer,
      class: scorer.scorerClass,
      calibration: {
        required: scorer.scorerClass === 'judge',
        calibrated: scorer.scorerClass === 'judge' ? latest?.verdict === 'pass' : true,
        latest,
      },
    };
  });

  const uncalibrated = scorers.filter(
    (scorer) => scorer.class === 'judge' && !scorer.calibration.calibrated,
  );
  const resolution = resolveAllGates(definition.manifest);

  return {
    factory,
    scorers,
    budget: {
      maxPerDay: config.scoringMaxScoresPerDay,
      usedToday,
      remaining: Math.max(0, config.scoringMaxScoresPerDay - usedToday),
    },
    benchmarkGate: {
      required: resolution.benchmarkGateRequired,
      satisfied: !resolution.benchmarkGateRequired || uncalibrated.length === 0,
      reason:
        resolution.benchmarkGateRequired && uncalibrated.length > 0
          ? `uncalibrated judge scorer(s): ${uncalibrated.map((scorer) => scorer.name).join(', ')}`
          : null,
    },
  };
}

/* ----------------------------------------------------------------- scores */

export interface ScoreFiltersInput {
  factory?: string;
  run?: string;
  workItem?: string;
  stage?: string;
  scorer?: string;
  window?: string;
  limit?: number;
  offset?: number;
}

export interface ScoresResponse {
  scores: ScoreRecord[];
  aggregate: ScoreAggregate[];
}

export async function listScoresForApi(filters: ScoreFiltersInput): Promise<ScoresResponse> {
  const sql = getSql();
  let since: string | undefined;
  if (filters.window) {
    try {
      since = parseMetricsWindow(filters.window).from;
    } catch (error) {
      if (error instanceof MetricsWindowError) throw invalidRequest(error.message);
      throw error;
    }
  }

  const base = {
    ...(filters.factory ? { factory: filters.factory } : {}),
    ...(filters.run ? { runId: filters.run } : {}),
    ...(filters.workItem ? { workItemId: filters.workItem } : {}),
    ...(filters.stage ? { stage: filters.stage } : {}),
    ...(filters.scorer ? { scorer: filters.scorer } : {}),
    ...(since ? { since } : {}),
  };

  const [scores, aggregate] = await Promise.all([
    listScores(sql, {
      ...base,
      limit: filters.limit ?? 100,
      offset: filters.offset ?? 0,
    }),
    aggregateScores(sql, base),
  ]);

  return { scores, aggregate };
}

export interface ScoreDetailResponse {
  score: ScoreRecord;
  evidence: NonNullable<ScoreRecord['evidence']>;
  events: ScoreEventRecord[];
  calibration: CalibrationResultRecord | null;
}

export async function getScoreForApi(id: string): Promise<ScoreDetailResponse> {
  const sql = getSql();
  const found = await getScore(sql, id);
  if (!found) throw scoreNotFound(id);

  const calibration =
    found.score.scorerClass === 'judge' && found.score.provenance.judgeModel
      ? await latestCalibrationResult(sql, {
          factory: found.score.factory,
          scorer: found.score.scorer,
          rubricHash: found.score.rubricHash,
          judgeModel: found.score.provenance.judgeModel,
        })
      : null;

  return {
    score: found.score,
    evidence: found.score.evidence ?? [],
    events: found.events,
    calibration,
  };
}

/* ------------------------------------------------------------ calibration */

export interface CalibrationItemResult {
  item: CalibrationItemRecord;
  judgeLabel: string | null;
  judgeScore: number | null;
  error: string | null;
}

export interface CalibrationResponse {
  factory: string;
  scorer: string;
  setId: string;
  setName: string;
  rubricHash: string;
  judgeModel: string;
  judgeModelVersion: string | null;
  calibration: ReturnType<typeof computeCalibration>;
  result: CalibrationResultRecord;
  items: CalibrationItemResult[];
}

export async function startCalibrationForApi(
  config: ApiConfig,
  body: CalibrationBody,
): Promise<CalibrationResponse> {
  const { registry } = registryOf(config, body.factory);
  const scorer = findScorer(registry, body.scorer);
  if (!scorer) {
    throw invalidRequest(`scorer "${body.scorer}" is not declared by factory "${body.factory}"`, {
      factory: body.factory,
      scorer: body.scorer,
      available: registry.map((entry) => entry.name),
    });
  }
  if (scorer.scorerClass !== 'judge') {
    throw invalidRequest(
      `scorer "${scorer.name}" is deterministic; deterministic scorers need no calibration`,
      { scorer: scorer.name, class: scorer.scorerClass },
    );
  }

  const sql = getSql();

  let setId: string;
  let setName: string;
  let minSize: number;
  let threshold: number;
  let tolerance: number;
  let itemRows: CalibrationItemRecord[];

  const appendItems = async (
    items: NonNullable<CalibrationBody['items']>,
  ): Promise<CalibrationItemRecord[]> => {
    const added: CalibrationItemRecord[] = [];
    for (const item of items) {
      const label = scorer.labels.find((candidate) => candidate.value === item.humanLabel);
      if (!label) {
        throw invalidRequest(
          `human label "${item.humanLabel}" is not declared by scorer "${scorer.name}"`,
          {
            scorer: scorer.name,
            label: item.humanLabel,
            allowed: scorer.labels.map((candidate) => candidate.value),
          },
        );
      }
      const run = await getRun(item.runId);
      if (!run) throw runNotFound(item.runId);
      added.push(
        await addCalibrationItem(sql, {
          setId,
          runId: item.runId,
          workItemId: null,
          humanLabel: item.humanLabel,
          humanScore: item.humanScore ?? label.score,
          notes: item.notes ?? null,
        }),
      );
    }
    return added;
  };

  if (body.setId) {
    const sets = await listCalibrationSets(sql, { factory: body.factory, scorer: scorer.name });
    const set = sets.find((candidate) => candidate.id === body.setId);
    if (!set) {
      throw invalidRequest(`calibration set "${body.setId}" does not exist`, {
        setId: body.setId,
      });
    }
    setId = set.id;
    setName = set.name;
    minSize = set.minSize;
    threshold = set.threshold;
    tolerance = set.tolerance;
    if (body.items) await appendItems(body.items);
    itemRows = await listCalibrationItems(sql, setId);
  } else {
    minSize = body.minSize ?? DEFAULT_CALIBRATION_MIN_SIZE;
    threshold = body.threshold ?? DEFAULT_CALIBRATION_THRESHOLD;
    tolerance = body.tolerance ?? DEFAULT_CALIBRATION_TOLERANCE;
    setId = `cal_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    setName = body.name ?? `${scorer.name} golden set`;
    await createCalibrationSet(sql, {
      id: setId,
      factory: body.factory,
      scorer: scorer.name,
      name: setName,
      minSize,
      threshold,
      tolerance,
    });
    itemRows = await appendItems(body.items ?? []);
  }

  const client = (() => {
    try {
      return createJudgeClient(config.scoringJudgeMode);
    } catch (error) {
      throw new ApiError(
        'judge_unavailable',
        503,
        error instanceof Error ? error.message : String(error),
        { factory: body.factory, scorer: scorer.name, mode: config.scoringJudgeMode },
      );
    }
  })();
  const observations: CalibrationItemObservation[] = [];
  const itemResults: CalibrationItemResult[] = [];
  let judgeModelVersion: string | null = null;

  for (const item of itemRows) {
    let judgeLabel: string | null = null;
    let judgeScore: number | null = null;
    let error: string | null = null;

    if (!item.runId) {
      error = 'calibration item has no run reference';
    } else {
      try {
        const context = await buildRunContext({ runId: item.runId, factory: body.factory });
        const result = await runJudgeScorer({ scorer, client, context });
        judgeLabel = result.label;
        judgeScore = result.score;
        judgeModelVersion ??= result.provenance.judgeModelVersion;
      } catch (judgeError) {
        error =
          judgeError instanceof JudgeError
            ? `${judgeError.code}: ${judgeError.message}`
            : judgeError instanceof Error
              ? judgeError.message
              : String(judgeError);
      }
    }

    observations.push({
      humanLabel: item.humanLabel,
      humanScore: item.humanScore,
      judgeLabel,
      judgeScore,
    });
    itemResults.push({ item, judgeLabel, judgeScore, error });
  }

  const computation = computeCalibration(observations, { minSize, threshold, tolerance });
  const result = await recordCalibrationResult(sql, {
    setId,
    factory: body.factory,
    scorer: scorer.name,
    rubricHash: scorer.rubricHash,
    judgeModel: scorer.judgeModel,
    judgeModelVersion,
    sampleSize: computation.sampleSize,
    agreementExact: computation.agreementExact,
    agreementWithinTolerance: computation.agreementWithinTolerance,
    tolerance: computation.tolerance,
    threshold: computation.threshold,
    confusion: computation.confusion,
    verdict: computation.verdict,
  });

  log('info', 'calibration_completed', {
    factory: body.factory,
    scorer: scorer.name,
    setId,
    verdict: computation.verdict,
    sampleSize: computation.sampleSize,
  });

  return {
    factory: body.factory,
    scorer: scorer.name,
    setId,
    setName,
    rubricHash: scorer.rubricHash,
    judgeModel: scorer.judgeModel,
    judgeModelVersion,
    calibration: computation,
    result,
    items: itemResults,
  };
}

export interface CalibrationStatusResponse {
  factory: string;
  scorer: string;
  rubricHash: string;
  judgeModel: string;
  calibrated: boolean;
  latest: CalibrationResultRecord | null;
  sets: {
    id: string;
    name: string;
    minSize: number;
    threshold: number;
    tolerance: number;
    itemCount: number;
    items: CalibrationItemRecord[];
  }[];
  results: CalibrationResultRecord[];
}

export async function getCalibrationForApi(
  config: ApiConfig,
  factory: string,
  scorerName: string,
): Promise<CalibrationStatusResponse> {
  const { registry } = registryOf(config, factory);
  const scorer = findScorer(registry, scorerName);
  if (!scorer) {
    throw invalidRequest(`scorer "${scorerName}" is not declared by factory "${factory}"`, {
      factory,
      scorer: scorerName,
    });
  }

  const sql = getSql();
  const [sets, results] = await Promise.all([
    listCalibrationSets(sql, { factory, scorer: scorer.name }),
    listCalibrationResults(sql, { factory, scorer: scorer.name, limit: 50 }),
  ]);

  const latest =
    results.find(
      (result) =>
        result.rubricHash === scorer.rubricHash && result.judgeModel === scorer.judgeModel,
    ) ?? null;

  const setsWithItems = [];
  for (const set of sets) {
    const items = await listCalibrationItems(sql, set.id);
    setsWithItems.push({
      id: set.id,
      name: set.name,
      minSize: set.minSize,
      threshold: set.threshold,
      tolerance: set.tolerance,
      itemCount: items.length,
      items,
    });
  }

  return {
    factory,
    scorer: scorer.name,
    rubricHash: scorer.rubricHash,
    judgeModel: scorer.judgeModel,
    calibrated: latest?.verdict === 'pass',
    latest,
    sets: setsWithItems,
    results,
  };
}

/* ----------------------------------------------------------------- metrics */

export interface MetricsApiResponse {
  factory: string;
  window: { from: string; to: string; days: number; label: string };
  metrics: Awaited<ReturnType<typeof computeFactoryMetrics>>['metrics'];
  costByStage: Awaited<ReturnType<typeof computeFactoryMetrics>>['costByStage'];
  unattributedCost: Awaited<ReturnType<typeof computeFactoryMetrics>>['unattributedCost'];
  benchmarkGate: { required: boolean; satisfied: boolean; reason: string | null };
}

export async function getMetricsForApi(
  config: ApiConfig,
  factory: string,
  windowInput?: string | null,
): Promise<MetricsApiResponse> {
  const { definition } = loadFactory(config, factory);
  const sql = getSql();
  let metrics: Awaited<ReturnType<typeof computeFactoryMetrics>>;
  try {
    metrics = await computeFactoryMetrics(sql, factory, windowInput);
  } catch (error) {
    if (error instanceof MetricsWindowError) throw invalidRequest(error.message);
    throw error;
  }

  const registry = loadScorerRegistry(definition);
  const results = await listCalibrationResults(sql, { factory, limit: 200 });
  const uncalibrated = registry.filter((scorer) => {
    if (scorer.scorerClass !== 'judge') return false;
    const latest =
      results.find(
        (result) =>
          result.scorer === scorer.name &&
          result.rubricHash === scorer.rubricHash &&
          result.judgeModel === scorer.judgeModel,
      ) ?? null;
    return latest?.verdict !== 'pass';
  });
  const resolution = resolveAllGates(definition.manifest);

  return {
    ...metrics,
    benchmarkGate: {
      required: resolution.benchmarkGateRequired,
      satisfied: !resolution.benchmarkGateRequired || uncalibrated.length === 0,
      reason:
        resolution.benchmarkGateRequired && uncalibrated.length > 0
          ? `uncalibrated judge scorer(s): ${uncalibrated.map((scorer) => scorer.name).join(', ')}`
          : null,
    },
  };
}

/* --------------------------------------------------------------- scoring run */

export interface StartScoringResponse {
  factory: string;
  trigger: 'on_demand';
  workflow: StartedScoring;
  runs: string[];
}

export async function startScoringForApi(
  config: ApiConfig,
  body: ScoringBody,
): Promise<StartScoringResponse> {
  const { dir } = loadFactory(config, body.factory);

  if (body.runId) {
    const run = await getRun(body.runId);
    if (!run) throw runNotFound(body.runId);
    if (!['ok', 'error', 'cancelled'].includes(run.status)) {
      throw invalidRequest(
        `run "${body.runId}" is not terminal (status: ${run.status}); score it after it finishes`,
        { runId: body.runId, status: run.status },
      );
    }
  }

  const workflow = await startScoringWorkflow(
    {
      factory: body.factory,
      factoryRoot: dir,
      trigger: 'on_demand',
      ...(body.runId ? { runIds: [body.runId] } : {}),
      ...(body.workItemId ? { workItemId: body.workItemId } : {}),
      ...(body.stage ? { stage: body.stage } : {}),
      ...(body.windowDays !== undefined ? { windowDays: body.windowDays } : {}),
      // An explicit human request for a specific run bypasses sampling and cadence.
      force: body.force ?? Boolean(body.runId),
    },
    toOrchestrationConfig(config),
  ).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    log('error', 'scoring_start_failed', { factory: body.factory, message });
    throw new ApiError('orchestrator_unavailable', 503, 'could not start the scoring workflow', {
      factory: body.factory,
      error: message,
    });
  });

  log('info', 'scoring_started', {
    factory: body.factory,
    workflowId: workflow.workflowId,
    runId: body.runId ?? null,
  });

  return {
    factory: body.factory,
    trigger: 'on_demand',
    workflow,
    runs: body.runId ? [body.runId] : [],
  };
}
