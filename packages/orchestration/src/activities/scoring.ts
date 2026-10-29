import { randomBytes, createHash } from 'node:crypto';
import { ApplicationFailure } from '@temporalio/activity';
import {
  countJudgeScoresToday,
  createScoreRun,
  finishScoreRun,
  latestCalibrationResult,
  latestScoreAt,
  loadDefinition,
  parseStageRunId,
  recordScore,
  upsertScorerDefinition,
  type ScoreRunRecord,
} from '@factory/core';
import {
  JudgeError,
  createJudgeClient,
  decideJudgeSampling,
  evaluateDeterministic,
  findScorer,
  loadScorerRegistry,
  runJudgeScorer,
  type JudgeClient,
  type ScoreDraft,
  type ScorerRegistryEntry,
} from '@factory/evals';
import { loadConfig } from '../config';
import { getSql } from '../db';
import { buildRunContext } from '../scoring/context';
import type {
  ScorableRunSummary,
  ScoringPlan,
  ScoringPlanItem,
} from '../types';

/**
 * Scoring activities.
 *
 * They run after a run reaches a terminal state, never inside a run workflow, so a scorer
 * failure can only mark a score `error` — the run is untouched. Deterministic scorers are
 * free and always run; judges are sampled and bounded by a per-factory daily cap.
 */

let judgeClientOverride: JudgeClient | null = null;

/** Test hook: inject a failing/scripted judge without network or credentials. */
export function setScoringJudgeClient(client: JudgeClient | null): void {
  judgeClientOverride = client;
}

function judgeClient(mode: 'stub' | 'openai'): JudgeClient {
  if (judgeClientOverride) return judgeClientOverride;
  try {
    return createJudgeClient(mode);
  } catch (error) {
    throw ApplicationFailure.create({
      type: 'judge_unavailable',
      nonRetryable: true,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function loadRegistry(factoryRoot: string): ScorerRegistryEntry[] {
  const { definition, errors } = loadDefinition(factoryRoot);
  if (!definition) {
    throw ApplicationFailure.create({
      type: 'definition_invalid',
      nonRetryable: true,
      message: `scoring cannot load the definition: ${errors
        .map((error) => `${error.code} ${error.pointer}`)
        .join(', ')}`,
      details: [{ errors }],
    });
  }
  return loadScorerRegistry(definition);
}

function requireScorer(
  registry: ScorerRegistryEntry[],
  name: string,
  rubricHash: string,
): ScorerRegistryEntry {
  const scorer = findScorer(registry, name);
  if (!scorer) {
    throw ApplicationFailure.create({
      type: 'scorer_not_found',
      nonRetryable: true,
      message: `scorer "${name}" is not declared by this factory`,
    });
  }
  if (scorer.rubricHash !== rubricHash) {
    throw ApplicationFailure.create({
      type: 'rubric_changed',
      nonRetryable: true,
      message: `scorer "${name}" rubric changed since planning (${rubricHash} → ${scorer.rubricHash})`,
    });
  }
  return scorer;
}

/* -------------------------------------------------------------- score runs */

export async function createScoreRunActivity(args: {
  factory: string;
  runId?: string | null;
  workItemId?: string | null;
  stage?: string | null;
  trigger: 'scheduled' | 'on_demand';
  windowDays?: number | null;
}): Promise<{ scoreRunId: string }> {
  const scoreRunId = `srun_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`;
  await createScoreRun(getSql(), {
    id: scoreRunId,
    factory: args.factory,
    runId: args.runId ?? null,
    workItemId: args.workItemId ?? null,
    stage: args.stage ?? null,
    trigger: args.trigger,
    windowDays: args.windowDays ?? null,
  });
  return { scoreRunId };
}

export async function finishScoreRunActivity(args: {
  scoreRunId: string;
  status: 'completed' | 'error';
  scorers: number;
  scored: number;
  skipped: number;
  errored: number;
  budgetExhausted: boolean;
  error?: string | null;
}): Promise<ScoreRunRecord> {
  return await finishScoreRun(getSql(), {
    id: args.scoreRunId,
    status: args.status,
    scorers: args.scorers,
    scored: args.scored,
    skipped: args.skipped,
    errored: args.errored,
    budgetExhausted: args.budgetExhausted,
    error: args.error ?? null,
  });
}

/* ------------------------------------------------------------ eligibility */

const TERMINAL = new Set(['ok', 'error', 'cancelled']);

export async function listScorableRuns(args: {
  factory: string;
  runIds?: string[];
  workItemId?: string;
  stage?: string;
  windowDays?: number;
}): Promise<ScorableRunSummary[]> {
  const sql = getSql();
  let rows: { id: string; status: string }[];

  if (args.runIds && args.runIds.length > 0) {
    rows = [];
    for (const runId of args.runIds.slice(0, 200)) {
      const found = (await sql`
        select id, status from runs where id = ${runId} limit 1
      `) as { id: string; status: string }[];
      if (found[0]) rows.push(found[0]);
    }
  } else {
    const windowDays = Math.max(1, Math.min(args.windowDays ?? 1, 90));
    const from = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();
    rows = (await sql`
      select id, status from runs
      where factory = ${args.factory}
        and status in ('ok', 'error', 'cancelled')
        and started_at >= ${from}::timestamptz
      order by started_at desc
      limit 200
    `) as { id: string; status: string }[];
  }

  return rows
    .filter((row) => TERMINAL.has(row.status))
    .map((row) => {
      const parsed = parseStageRunId(row.id);
      return {
        runId: row.id,
        workItemId: parsed?.workItemId ?? null,
        stage: parsed?.stage ?? null,
        status: row.status,
      };
    })
    .filter((run) => !args.workItemId || run.workItemId === args.workItemId)
    .filter((run) => !args.stage || run.stage === args.stage);
}

/* ---------------------------------------------------------------- planning */

export async function planScoring(args: {
  factory: string;
  factoryRoot: string;
  runs: ScorableRunSummary[];
  force?: boolean;
  maxScoresPerDay?: number;
  cadenceMs?: number;
}): Promise<ScoringPlan> {
  const config = loadConfig();
  const sql = getSql();
  const registry = loadRegistry(args.factoryRoot);
  const maxPerDay = Math.max(
    0,
    Math.trunc(args.maxScoresPerDay ?? config.scoringMaxScoresPerDay),
  );
  const cadenceMs = Math.max(0, Math.trunc(args.cadenceMs ?? config.scoringCadenceMs));

  // The DB indexes the git-backed definitions so calibration joins can find them.
  for (const scorer of registry) {
    await upsertScorerDefinition(sql, {
      factory: args.factory,
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

  let usedToday = await countJudgeScoresToday(sql, args.factory);
  const lastScoredAt = new Map<string, string | null>();
  for (const scorer of registry) {
    lastScoredAt.set(scorer.name, await latestScoreAt(sql, args.factory, scorer.name));
  }

  const items: ScoringPlanItem[] = [];
  let budgetExhausted = false;
  const now = Date.now();

  for (const run of args.runs) {
    for (const scorer of registry) {
      if (scorer.scorerClass === 'deterministic') {
        items.push({
          runId: run.runId,
          workItemId: run.workItemId,
          stage: run.stage,
          scorer: scorer.name,
          scorerClass: 'deterministic',
          rubricHash: scorer.rubricHash,
          selected: true,
          reason: null,
        });
        continue;
      }

      const decision = decideJudgeSampling({
        runId: run.runId,
        samplingRate: scorer.samplingRate,
        usedToday,
        maxPerDay,
        lastScoredAt: lastScoredAt.get(scorer.name) ?? null,
        cadenceMs,
        now,
        force: args.force ?? false,
      });

      if (decision.selected) usedToday += 1;
      if (decision.reason === 'budget_exhausted') budgetExhausted = true;

      items.push({
        runId: run.runId,
        workItemId: run.workItemId,
        stage: run.stage,
        scorer: scorer.name,
        scorerClass: 'judge',
        rubricHash: scorer.rubricHash,
        selected: decision.selected,
        reason: decision.reason,
      });
    }
  }

  return { items, budgetExhausted };
}

/* ----------------------------------------------------------------- scoring */

export async function runDeterministic(args: {
  factory: string;
  factoryRoot: string;
  runId: string;
  scorer: string;
  rubricHash: string;
}): Promise<ScoreDraft> {
  const scorer = requireScorer(loadRegistry(args.factoryRoot), args.scorer, args.rubricHash);
  const context = await buildRunContext({ runId: args.runId, factory: args.factory });
  const outcome = evaluateDeterministic(scorer, context.evidence);

  return {
    factory: args.factory,
    runId: args.runId,
    workItemId: context.workItemId,
    stage: context.stage,
    scorer: scorer.name,
    scorerClass: 'deterministic',
    rubricHash: scorer.rubricHash,
    status: outcome.status,
    errorCode: outcome.errorCode,
    label: outcome.label,
    score: outcome.score,
    passing: outcome.passing,
    rationale: outcome.rationale,
    evidenceRefs: outcome.evidenceRefs,
    evidence: outcome.evidence,
    uncalibrated: false,
    provenance: null,
  };
}

export async function runJudge(args: {
  factory: string;
  factoryRoot: string;
  runId: string;
  scorer: string;
  rubricHash: string;
  judgeMode?: 'stub' | 'openai';
}): Promise<ScoreDraft> {
  const scorer = requireScorer(loadRegistry(args.factoryRoot), args.scorer, args.rubricHash);
  const context = await buildRunContext({ runId: args.runId, factory: args.factory });

  const base = {
    factory: args.factory,
    runId: args.runId,
    workItemId: context.workItemId,
    stage: context.stage,
    scorer: scorer.name,
    scorerClass: 'judge' as const,
    rubricHash: scorer.rubricHash,
    evidenceRefs: [
      ...(context.terminalSeq !== null ? [`event:${context.terminalSeq}`] : []),
      ...(context.diff ? ['artifact:patch.diff'] : []),
      ...(context.workItemId ? [`work_item:${context.workItemId}`] : []),
    ],
    evidence: [
      ...(context.terminalSeq !== null
        ? [{ kind: 'event' as const, ref: `event:${context.terminalSeq}`, detail: { type: 'run.completed' } }]
        : []),
      ...(context.diff
        ? [{ kind: 'artifact' as const, ref: 'artifact:patch.diff', detail: { bytes: context.diff.length } }]
        : []),
      ...(context.workItemId
        ? [{ kind: 'work_item' as const, ref: `work_item:${context.workItemId}`, detail: {} }]
        : []),
    ],
    uncalibrated: false,
  };

  try {
    const result = await runJudgeScorer({
      scorer,
      client: judgeClient(args.judgeMode ?? loadConfig().scoringJudgeMode),
      context,
    });
    return {
      ...base,
      status: 'ok',
      errorCode: null,
      label: result.label,
      score: result.score,
      passing: result.passing,
      rationale: result.rationale,
      provenance: result.provenance,
    };
  } catch (error) {
    const code = error instanceof JudgeError ? error.code : 'judge_error';
    return {
      ...base,
      status: 'error',
      errorCode: code,
      label: null,
      score: null,
      passing: false,
      rationale: error instanceof Error ? error.message : String(error),
      provenance: null,
    };
  }
}

/* ------------------------------------------------------------- persistence */

export function scoreIdFor(runId: string, scorer: string, rubricHash: string): string {
  return `sc_${createHash('sha256')
    .update(`${runId}\u0000${scorer}\u0000${rubricHash}`)
    .digest('hex')
    .slice(0, 24)}`;
}

export async function persistScore(args: {
  scoreRunId: string | null;
  draft: ScoreDraft;
}): Promise<{ scoreId: string; status: ScoreDraft['status']; eventType: string; eventAppended: boolean }> {
  const sql = getSql();
  const { draft } = args;
  const scoreId = scoreIdFor(draft.runId, draft.scorer, draft.rubricHash);

  let uncalibrated = false;
  if (draft.scorerClass === 'judge' && draft.status === 'ok') {
    const judgeModel = draft.provenance?.judgeModel ?? null;
    if (judgeModel) {
      const calibration = await latestCalibrationResult(sql, {
        factory: draft.factory,
        scorer: draft.scorer,
        rubricHash: draft.rubricHash,
        judgeModel,
      });
      uncalibrated = calibration?.verdict !== 'pass';
    } else {
      uncalibrated = true;
    }
  }

  const result = await recordScore(sql, {
    id: scoreId,
    scoreRunId: args.scoreRunId,
    factory: draft.factory,
    runId: draft.runId,
    workItemId: draft.workItemId,
    stage: draft.stage,
    scorer: draft.scorer,
    scorerClass: draft.scorerClass,
    rubricHash: draft.rubricHash,
    status: draft.status,
    errorCode: draft.errorCode,
    label: draft.label,
    score: draft.score,
    passing: draft.passing,
    rationale: draft.rationale,
    evidenceRefs: draft.evidenceRefs,
    evidence: draft.evidence,
    uncalibrated,
    provenance: draft.provenance ?? {},
  });

  return {
    scoreId: result.score.id,
    status: result.score.status,
    eventType: result.eventType,
    eventAppended: result.eventAppended,
  };
}
