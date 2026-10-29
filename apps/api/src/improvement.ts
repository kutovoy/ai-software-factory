import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import {
  appendLessonFiles,
  assessEligibility,
  lessonFromProposal,
  loadScorerRegistry,
  type LessonDraft,
} from '@factory/evals';
import {
  canonicalYaml,
  createImprovementRun,
  createProposal,
  factorySchema,
  finishImprovementRun,
  getActiveCanaryRollout,
  getCanaryRollout,
  getImprovementRun,
  getInFlightCanaryRollout,
  getLesson,
  getProposal,
  latestCalibrationResult,
  listCanaryEvents,
  listCanaryRollouts,
  listImprovementEvents,
  listImprovementRuns,
  listLessons,
  listProposalEdits,
  listProbes,
  listProposals,
  loadDefinition,
  mapZodIssues,
  markImprovementRunning,
  promoteLesson,
  recordLesson,
  resolveImprovement,
  serializeDefinition,
  updateProposal,
  type CanaryEventRecord,
  type CanaryRolloutRecord,
  type FactoryDefinition,
  type FactoryManifest,
  type LessonRecord,
  type ProposalEditRecord,
  type ProposalRecord,
  type ProbeRecord,
  type ImprovementRunRecord,
} from '@factory/core';
import {
  applyImprovementDecision,
  getForge,
  getSql,
  promoteCanaryRollout,
  readCanaryObservation,
  resolveCanaryRollout,
  rollbackCanaryRollout,
  signalCanaryPromote,
  signalCanaryRollback,
  startCanaryRollout,
  startImprovementWorkflow,
  type CanaryObservationSummary,
  type ImprovementWorkflowInput,
} from '@factory/orchestration';
import { FakeForge, type FileChange } from '@factory/forge';
import type { ApiConfig } from './config';
import { toOrchestrationConfig } from './config';
import {
  ApiError,
  canaryActive,
  canaryNotAvailable,
  definitionInvalid,
  invalidRequest,
  lessonNotFound,
  noActiveCanary,
  proposalNotAccepted,
  proposalNotDecidable,
  proposalNotFound,
} from './errors';
import { resolveFactoryDir } from './factories';
import { log } from './logger';
import { pinVersion } from './runs';

/**
 * Self-improvement API (Phase 5, spec `self-improvement`).
 *
 * Reads are projections of the git-backed definition + the improvement read model.
 * `POST .../improvement/run` starts one `ImprovementWorkflow`; decisions and applies route
 * by the authority recorded on the proposal (which came from `factory.yaml` when the
 * proposal was created). An authority change is itself a definition change: the API
 * returns the diff, requires confirmation, and opens a PR — it never writes the worktree.
 */

export const IMPROVEMENT_AUTHORITIES = ['propose_only', 'auto_merge_on_benchmark', 'canary'] as const;

export const improvementRunBodySchema = z
  .object({
    trigger: z.enum(['scheduled', 'on_demand']).optional(),
    /** Observe exactly these runs (on-demand); bypasses the window scan. */
    runIds: z.array(z.string().min(1)).min(1).max(50).optional(),
    windowDays: z.number().int().min(1).max(90).optional(),
    minScoredRuns: z.number().int().min(1).max(50).optional(),
    maxProbes: z.number().int().min(1).max(50).optional(),
    /** Override the canary traffic split for a rollout started by this run. */
    canaryPercent: z.number().int().min(1).max(100).optional(),
  })
  .strict();

export type ImprovementRunBody = z.infer<typeof improvementRunBodySchema>;

export const proposalDecisionBodySchema = z
  .object({
    decision: z.enum(['accept', 'reject']),
    actor: z.string().min(1).max(120),
    reason: z.string().min(1).max(2_000),
  })
  .strict();

export type ProposalDecisionBody = z.infer<typeof proposalDecisionBodySchema>;

export const proposalApplyBodySchema = z
  .object({
    actor: z.string().min(1).max(120),
    reason: z.string().min(1).max(2_000),
  })
  .strict();

export type ProposalApplyBody = z.infer<typeof proposalApplyBodySchema>;

export const authorityChangeBodySchema = z
  .object({
    authority: z.enum(IMPROVEMENT_AUTHORITIES),
    canaryPercent: z.number().int().min(1).max(100).optional(),
    rollbackThreshold: z.number().min(0).max(1).optional(),
    actor: z.string().min(1).max(120),
    reason: z.string().min(1).max(2_000),
    /** Without it the API returns the diff and changes nothing. */
    confirm: z.boolean().optional(),
  })
  .strict();

export type AuthorityChangeBody = z.infer<typeof authorityChangeBodySchema>;

export const promoteLessonBodySchema = z
  .object({
    actor: z.string().min(1).max(120),
    reason: z.string().min(1).max(2_000).optional(),
  })
  .strict();

export type PromoteLessonBody = z.infer<typeof promoteLessonBodySchema>;

export const canaryRollbackBodySchema = z
  .object({
    factory: z.string().min(1),
    proposalId: z.string().min(1).optional(),
    rolloutId: z.string().min(1).optional(),
    actor: z.string().min(1).max(120),
    reason: z.string().min(1).max(2_000),
  })
  .strict();

export type CanaryRollbackBody = z.infer<typeof canaryRollbackBodySchema>;

/** Manual promote takes the same targeting shape as rollback. */
export const canaryPromoteBodySchema = canaryRollbackBodySchema;

export type CanaryPromoteBody = z.infer<typeof canaryPromoteBodySchema>;

export const canaryStartBodySchema = z
  .object({
    proposalId: z.string().min(1),
    actor: z.string().min(1).max(120),
    reason: z.string().min(1).max(2_000),
    /** Explicit rollout override; defaults to `improvement.canaryPercent`. */
    canaryPercent: z.number().int().min(1).max(100).optional(),
    /** Explicit window override in hours; defaults to `improvement.observationWindowHours`. */
    observationWindowHours: z.number().int().min(1).max(720).optional(),
  })
  .strict();

export type CanaryStartBody = z.infer<typeof canaryStartBodySchema>;

interface LoadedFactory {
  dir: string;
  definition: FactoryDefinition;
  commit: string;
  dirty: boolean;
}

function loadFactory(config: ApiConfig, factory: string): LoadedFactory {
  const dir = resolveFactoryDir(config, factory);
  const { definition, errors } = loadDefinition(dir);
  if (!definition) throw definitionInvalid(factory, errors);
  const { commit, dirty } = pinVersion(dir, factory);
  return { dir, definition, commit, dirty };
}

/* --------------------------------------------------------------- eligibility */

async function eligibilityPreview(
  config: ApiConfig,
  factory: string,
  definition: FactoryDefinition,
  authority: ReturnType<typeof resolveImprovement>['authority'],
): Promise<ReturnType<typeof assessEligibility>> {
  const sql = getSql();
  const windowDays = config.improvementWindowDays;
  const from = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();
  const rows = (await sql`
    select count(distinct run_id) as scored
    from scores
    where factory = ${factory} and created_at >= ${from}::timestamptz
  `) as { scored: number | string }[];
  const scoredRuns = Number(rows[0]?.scored ?? 0);

  const judges: {
    scorer: string;
    rubricHash: string;
    judgeModel: string;
    calibrated: boolean;
  }[] = [];
  for (const scorer of loadScorerRegistry(definition).filter(
    (entry) => entry.scorerClass === 'judge',
  )) {
    const calibration = await latestCalibrationResult(sql, {
      factory,
      scorer: scorer.name,
      rubricHash: scorer.rubricHash,
      judgeModel: scorer.judgeModel,
    });
    judges.push({
      scorer: scorer.name,
      rubricHash: scorer.rubricHash,
      judgeModel: scorer.judgeModel,
      calibrated: calibration?.verdict === 'pass',
    });
  }

  return assessEligibility({
    authority,
    minScoredRuns: config.improvementMinScoredRuns,
    scoredRuns,
    judges,
  });
}

/* ------------------------------------------------------------------ overview */

export interface ImprovementOverview {
  factory: string;
  definitionCommit: string;
  definitionDirty: boolean;
  authority: ReturnType<typeof resolveImprovement>['authority'];
  resolved: ReturnType<typeof resolveImprovement>;
  eligibility: ReturnType<typeof assessEligibility>;
  lastRun: ImprovementRunRecord | null;
  proposals: ProposalRecord[];
  lessonCount: number;
  canary: {
    available: boolean;
    configuredPercent: number | null;
    rollbackThreshold: number | null;
    observationWindowHours: number;
    active: {
      rolloutId: string;
      status: CanaryRolloutRecord['status'];
      candidateVersion: string;
      stableVersion: string;
      canaryPercent: number;
      startedAt: string | null;
      endsAt: string | null;
    } | null;
  };
}

export async function getImprovementForApi(
  config: ApiConfig,
  factory: string,
): Promise<ImprovementOverview> {
  const { definition, commit, dirty } = loadFactory(config, factory);
  const resolved = resolveImprovement(definition.manifest.improvement);
  const sql = getSql();

  const [eligibility, lastRun, proposals, lessons, active] = await Promise.all([
    eligibilityPreview(config, factory, definition, resolved.authority),
    listImprovementRuns(sql, { factory, limit: 1 }).then((runs) => runs[0] ?? null),
    listProposals(sql, { factory, limit: 10 }),
    listLessons(sql, { factory, includeShared: true, limit: 100 }),
    getActiveCanaryRollout(sql, factory),
  ]);

  return {
    factory,
    definitionCommit: commit,
    definitionDirty: dirty,
    authority: resolved.authority,
    resolved,
    eligibility,
    lastRun,
    proposals,
    lessonCount: lessons.length,
    canary: {
      available: resolved.canaryAvailable,
      configuredPercent: resolved.canaryPercent,
      rollbackThreshold: resolved.rollbackThreshold,
      observationWindowHours: resolved.observationWindowHours,
      active: active
        ? {
            rolloutId: active.id,
            status: active.status,
            candidateVersion: active.candidateVersion,
            stableVersion: active.stableVersion,
            canaryPercent: active.canaryPercent,
            startedAt: active.startedAt,
            endsAt: canaryEndsAt(active),
          }
        : null,
    },
  };
}

/* ----------------------------------------------------------------- proposals */

export interface ProposalView extends ProposalRecord {
  edits: ProposalEditRecord[];
  probes: ProbeRecord[];
}

export async function listProposalsForApi(
  filters: { factory?: string; status?: ProposalRecord['status']; limit?: number } = {},
): Promise<ProposalView[]> {
  const sql = getSql();
  const proposals = await listProposals(sql, {
    ...(filters.factory ? { factory: filters.factory } : {}),
    ...(filters.status ? { status: filters.status } : {}),
    limit: Math.min(filters.limit ?? 50, 100),
  });
  return await Promise.all(
    proposals.map(async (proposal) => ({
      ...proposal,
      edits: await listProposalEdits(sql, proposal.id),
      probes: await listProbes(sql, proposal.id),
    })),
  );
}

export interface ProposalDetailResponse {
  proposal: ProposalRecord;
  edits: ProposalEditRecord[];
  probes: ProbeRecord[];
  events: { type: string; subject: string; payload: Record<string, unknown>; createdAt: string | null }[];
}

export async function getProposalForApi(id: string): Promise<ProposalDetailResponse> {
  const sql = getSql();
  const proposal = await getProposal(sql, id);
  if (!proposal) throw proposalNotFound(id);

  const [edits, probes, events] = await Promise.all([
    listProposalEdits(sql, id),
    listProbes(sql, id),
    proposal.improvementRunId
      ? listImprovementEvents(sql, proposal.improvementRunId)
      : Promise.resolve([]),
  ]);

  return {
    proposal,
    edits,
    probes,
    events: events
      .filter((event) => event.subject === id || event.subject === '')
      .map((event) => ({
        type: event.type,
        subject: event.subject,
        payload: event.payload,
        createdAt: event.createdAt,
      })),
  };
}

/* ------------------------------------------------------------------ lessons */

function experienceDir(config: ApiConfig, factory: string): string {
  return join(config.runsDir, 'experience', factory);
}

function readIfExists(path: string): string | null {
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

async function appendLessonToLibrary(
  config: ApiConfig,
  factory: string,
  lesson: LessonDraft,
): Promise<void> {
  const dir = experienceDir(config, factory);
  mkdirSync(dir, { recursive: true });
  const appended = appendLessonFiles({
    factory,
    index: readIfExists(join(dir, 'INDEX.md')),
    experience: readIfExists(join(dir, 'EXPERIENCE.md')),
    lesson,
  });
  writeFileSync(join(dir, 'INDEX.md'), appended.index);
  writeFileSync(join(dir, 'EXPERIENCE.md'), appended.experience);
}

export async function listLessonsForApi(
  config: ApiConfig,
  args: { factory?: string; includeShared?: boolean; limit?: number } = {},
): Promise<{ lessons: LessonRecord[]; factory: string; includeShared: boolean }> {
  // Default to the configured factory: an unscoped read would leak another factory's
  // unpromoted lessons (spec: Isolation).
  const factory = args.factory ?? config.defaultFactory;
  const includeShared = args.includeShared ?? true;
  const lessons = await listLessons(getSql(), {
    factory,
    includeShared,
    limit: Math.min(args.limit ?? 100, 200),
  });
  return { lessons, factory, includeShared };
}

export async function promoteLessonForApi(
  id: string,
  body: PromoteLessonBody,
): Promise<LessonRecord> {
  const sql = getSql();
  const lesson = await getLesson(sql, id);
  if (!lesson) throw lessonNotFound(id);
  if (lesson.promoted) return lesson;
  const promoted = await promoteLesson(sql, { id, actor: body.actor, reason: body.reason ?? null });
  log('info', 'lesson_promoted', {
    lessonId: id,
    factory: promoted.factory,
    actor: body.actor,
  });
  return promoted;
}

/* ------------------------------------------------------------------ canary */

/** End of the observation window, computed from the rollout start. */
function canaryEndsAt(rollout: CanaryRolloutRecord): string | null {
  if (!rollout.startedAt) return null;
  const start = Date.parse(rollout.startedAt);
  if (!Number.isFinite(start)) return null;
  return new Date(start + rollout.observationWindowHours * 60 * 60 * 1000).toISOString();
}

export interface CanarySplit {
  canaryPercent: number;
  stablePercent: number;
  candidateItems: number;
  stableItems: number;
  totalItems: number;
}

export interface CanaryWindow {
  startedAt: string | null;
  endsAt: string | null;
  elapsedMs: number;
  remainingMs: number;
  complete: boolean;
  observationWindowHours: number;
}

export interface CanaryRolloutView {
  rollout: CanaryRolloutRecord;
  window: CanaryWindow;
  split: CanarySplit;
  metrics: CanaryObservationSummary | null;
  events: { type: string; payload: Record<string, unknown>; createdAt: string | null }[];
}

export interface CanaryOverview {
  factory: string;
  definitionCommit: string;
  authority: ReturnType<typeof resolveImprovement>['authority'];
  resolved: ReturnType<typeof resolveImprovement>;
  available: boolean;
  active: CanaryRolloutView | null;
  history: CanaryRolloutView[];
  /** Open/accepted proposals with a composed candidate, ready to roll out. */
  proposals: ProposalRecord[];
}

function canaryApiError(error: unknown): never {
  const code = (error as { code?: string } | null)?.code ?? 'canary_error';
  const details = (error as { details?: unknown } | null)?.details;
  const status = code === 'canary_not_found' || code === 'proposal_not_found' ? 404 : 409;
  throw new ApiError(code, status, error instanceof Error ? error.message : String(error), details);
}

async function canarySplitFor(
  factory: string,
  rollout: CanaryRolloutRecord,
): Promise<CanarySplit> {
  const sql = getSql();
  const rows = (await sql`
    select definition_version, count(*) as items
    from work_items
    where factory = ${factory}
      and (
        canary_rollout_id = ${rollout.id}
        or (
          definition_version = 'stable'
          and canary_rollout_id is null
          and created_at >= ${rollout.startedAt ?? new Date(0).toISOString()}::timestamptz
          and (${rollout.endedAt}::timestamptz is null or created_at <= ${rollout.endedAt}::timestamptz)
        )
      )
    group by definition_version
  `) as { definition_version: string; items: number | string }[];
  const candidateItems = Number(rows.find((row) => row.definition_version === 'candidate')?.items ?? 0);
  const stableItems = Number(rows.find((row) => row.definition_version === 'stable')?.items ?? 0);
  return {
    canaryPercent: rollout.canaryPercent,
    stablePercent: 100 - rollout.canaryPercent,
    candidateItems,
    stableItems,
    totalItems: candidateItems + stableItems,
  };
}

function canaryWindowFor(rollout: CanaryRolloutRecord): CanaryWindow {
  const started = rollout.startedAt ? Date.parse(rollout.startedAt) : Number.NaN;
  const ends = canaryEndsAt(rollout);
  const now = Date.now();
  const elapsedMs = Number.isFinite(started) ? Math.max(0, now - started) : 0;
  const remainingMs =
    rollout.status === 'active' && ends ? Math.max(0, Date.parse(ends) - now) : 0;
  return {
    startedAt: rollout.startedAt,
    endsAt: ends,
    elapsedMs,
    remainingMs,
    complete: rollout.status !== 'active' || remainingMs === 0,
    observationWindowHours: rollout.observationWindowHours,
  };
}

async function canaryMetricsFor(
  rollout: CanaryRolloutRecord,
  definitionCommit: string,
): Promise<CanaryObservationSummary | null> {
  if (rollout.status === 'unavailable') return null;
  try {
    return await readCanaryObservation({
      factory: rollout.factory,
      rolloutId: rollout.id,
      stableCommit: rollout.stableCommit ?? definitionCommit,
      candidateCommit: rollout.candidateCommit,
      startedAt: rollout.startedAt,
      until: rollout.endedAt,
      rollbackThreshold: rollout.rollbackThreshold,
      canaryPercent: rollout.canaryPercent,
      observationWindowHours: rollout.observationWindowHours,
    });
  } catch {
    return null;
  }
}

async function canaryView(
  rollout: CanaryRolloutRecord,
  definitionCommit: string,
  options: { metrics?: boolean } = {},
): Promise<CanaryRolloutView> {
  const sql = getSql();
  const [split, metrics, events] = await Promise.all([
    canarySplitFor(rollout.factory, rollout),
    options.metrics === false ? Promise.resolve(null) : canaryMetricsFor(rollout, definitionCommit),
    listCanaryEvents(sql, { rolloutId: rollout.id }),
  ]);
  return {
    rollout,
    window: canaryWindowFor(rollout),
    split,
    metrics,
    events: events.map((event: CanaryEventRecord) => ({
      type: event.type,
      payload: event.payload,
      createdAt: event.createdAt,
    })),
  };
}

/**
 * Canary projection: the active rollout (split, window countdown, candidate-vs-stable
 * metrics), the history with its audit events, and the proposals that can start a rollout.
 */
export async function getCanaryForApi(
  config: ApiConfig,
  factory: string,
): Promise<CanaryOverview> {
  const { definition, commit } = loadFactory(config, factory);
  const resolved = resolveImprovement(definition.manifest.improvement);
  const sql = getSql();

  const [active, history, proposals] = await Promise.all([
    getActiveCanaryRollout(sql, factory),
    listCanaryRollouts(sql, { factory, limit: 10 }),
    listProposals(sql, { factory, limit: 20 }),
  ]);

  const historyViews = await Promise.all(
    history.map((rollout) => canaryView(rollout, commit, { metrics: true })),
  );

  return {
    factory,
    definitionCommit: commit,
    authority: resolved.authority,
    resolved,
    available: resolved.canaryAvailable,
    active: active ? await canaryView(active, commit) : null,
    history: historyViews,
    proposals: proposals.filter(
      (proposal) =>
        proposal.authority === 'canary' &&
        (proposal.status === 'accepted' || proposal.status === 'open' || proposal.status === 'canary') &&
        Boolean(proposal.candidateHash),
    ),
  };
}

export interface StartedCanaryRolloutResponse {
  factory: string;
  rollout: CanaryRolloutRecord;
  workflow: { workflowId: string; temporalRunId: string } | null;
  reused: boolean;
}

/**
 * Starts a real canary rollout for a composed proposal (Phase 5b). The candidate version is
 * published by `CanaryWorkflow`; until it activates, new work items stay on stable.
 */
export async function startCanaryForApi(
  config: ApiConfig,
  factory: string,
  body: CanaryStartBody,
): Promise<StartedCanaryRolloutResponse> {
  const { dir, definition, commit } = loadFactory(config, factory);
  const resolved = resolveImprovement(definition.manifest.improvement);
  if (resolved.authority !== 'canary') {
    throw new ApiError(
      'canary_not_applicable',
      409,
      `factory "${factory}" declares improvement authority "${resolved.authority}"; a canary rollout requires authority "canary"`,
      { factory, authority: resolved.authority },
    );
  }

  const canaryPercent = body.canaryPercent ?? resolved.canaryPercent;
  if (canaryPercent === null) {
    throw new ApiError('canary_config_missing', 422, 'improvement.canaryPercent is required', {
      factory,
    });
  }
  if (resolved.rollbackThreshold === null) {
    throw new ApiError('canary_config_missing', 422, 'improvement.rollbackThreshold is required', {
      factory,
    });
  }

  const sql = getSql();
  const proposal = await getProposal(sql, body.proposalId);
  if (!proposal || proposal.factory !== factory) throw proposalNotFound(body.proposalId);
  if (!proposal.candidateHash || proposal.diff.length === 0) {
    throw canaryNotAvailable({ proposalId: proposal.id, authority: proposal.authority });
  }

  try {
    const started = await startCanaryRollout({
      factory,
      factoryRoot: dir,
      definitionRepo: `${config.definitionRepoOwner}/${factory}`,
      baseBranch: 'main',
      proposal,
      stableCommit: commit,
      canaryPercent,
      rollbackThreshold: resolved.rollbackThreshold,
      observationWindowHours:
        body.observationWindowHours ?? resolved.observationWindowHours,
      actor: body.actor,
      reason: body.reason,
    });

    log('info', 'canary_started', {
      factory,
      rolloutId: started.rollout.id,
      proposalId: proposal.id,
      canaryPercent,
      reused: started.reused,
    });

    return {
      factory,
      rollout: started.rollout,
      workflow: started.workflow,
      reused: started.reused,
    };
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;
    if (code === 'canary_active') {
      const active = await getActiveCanaryRollout(sql, factory);
      throw canaryActive(factory, active?.id ?? 'unknown');
    }
    canaryApiError(error);
  }
}

export interface CanaryPromoteResponse {
  factory: string;
  rollout: CanaryRolloutRecord;
  mergedCommit: string | null;
  delivery: boolean;
}

/** Manual promotion: merges the candidate PR, ends the rollout `promoted`, wakes the workflow. */
export async function promoteCanaryForApi(
  config: ApiConfig,
  body: CanaryPromoteBody,
): Promise<CanaryPromoteResponse> {
  const rollout = await resolveCanaryRollout({
    factory: body.factory,
    rolloutId: body.rolloutId ?? null,
    proposalId: body.proposalId ?? null,
  });
  if (!rollout || rollout.status !== 'active') {
    throw noActiveCanary(body.factory, ['active']);
  }

  const observation = await canaryMetricsFor(
    rollout,
    rollout.stableCommit ?? loadFactory(config, body.factory).commit,
  );

  let result: Awaited<ReturnType<typeof promoteCanaryRollout>>;
  try {
    result = await promoteCanaryRollout({
      rolloutId: rollout.id,
      factory: body.factory,
      actor: body.actor,
      reason: body.reason,
      observation,
      automatic: false,
    });
  } catch (error) {
    canaryApiError(error);
  }

  const delivery = await signalCanaryPromote(
    rollout.id,
    { actor: body.actor, reason: body.reason },
    toOrchestrationConfig(config),
  );

  log('info', 'canary_promoted', {
    factory: body.factory,
    rolloutId: rollout.id,
    actor: body.actor,
    mergedCommit: result.mergedCommit ?? null,
  });

  return {
    factory: body.factory,
    rollout: result.rollout,
    mergedCommit: result.mergedCommit ?? null,
    delivery: delivery.delivered,
  };
}

export interface CanaryRollbackResponse {
  factory: string;
  rollout: CanaryRolloutRecord;
  delivery: boolean;
  metrics: CanaryObservationSummary | null;
}

/**
 * Manual rollback, regardless of the window: the read-model update makes the active-rollout
 * query stop matching immediately, so new work returns to stable even if the workflow
 * Signal never arrives. The evidence at rollback time is recorded on the event.
 */
export async function rollbackCanaryForApi(
  config: ApiConfig,
  body: CanaryRollbackBody,
): Promise<CanaryRollbackResponse> {
  const rollout = await resolveCanaryRollout({
    factory: body.factory,
    rolloutId: body.rolloutId ?? null,
    proposalId: body.proposalId ?? null,
  });
  if (!rollout || (rollout.status !== 'active' && rollout.status !== 'pending')) {
    throw noActiveCanary(body.factory, ['pending', 'active']);
  }

  const observation = await canaryMetricsFor(
    rollout,
    rollout.stableCommit ?? loadFactory(config, body.factory).commit,
  );

  let result: Awaited<ReturnType<typeof rollbackCanaryRollout>>;
  try {
    result = await rollbackCanaryRollout({
      rolloutId: rollout.id,
      factory: body.factory,
      actor: body.actor,
      reason: body.reason,
      observation,
      automatic: false,
    });
  } catch (error) {
    canaryApiError(error);
  }

  const delivery = await signalCanaryRollback(
    rollout.id,
    { actor: body.actor, reason: body.reason },
    toOrchestrationConfig(config),
  );

  log('info', 'canary_rolled_back', {
    factory: body.factory,
    rolloutId: rollout.id,
    actor: body.actor,
    reason: body.reason,
  });

  return {
    factory: body.factory,
    rollout: result.rollout,
    delivery: delivery.delivered,
    metrics: observation,
  };
}

/* ---------------------------------------------------------------- decisions */

function winningProbe(probes: ProbeRecord[]): ProbeRecord | null {
  return probes.find((probe) => probe.winner) ?? null;
}

function probeDeltaOf(probes: ProbeRecord[]): number | null {
  const winners = probes.filter((probe) => probe.winner);
  if (winners.length === 0) return null;
  return Math.max(...winners.map((probe) => probe.delta ?? 0));
}

export interface ProposalDecisionResponse {
  proposal: ProposalRecord;
  lesson: LessonRecord;
}

/**
 * Records a human accept/reject. The decision also appends a lesson to the factory's
 * experience library (spec: Record), so the loop learns even from a rejection.
 */
export async function decideProposalForApi(
  config: ApiConfig,
  id: string,
  body: ProposalDecisionBody,
): Promise<ProposalDecisionResponse> {
  const sql = getSql();
  const proposal = await getProposal(sql, id);
  if (!proposal) throw proposalNotFound(id);
  if (proposal.status !== 'open' && proposal.status !== 'pr_open') {
    throw proposalNotDecidable(id, proposal.status);
  }

  const accepted = body.decision === 'accept';
  const nextStatus: ProposalRecord['status'] = accepted
    ? proposal.status === 'pr_open'
      ? 'pr_open'
      : 'accepted'
    : 'rejected';
  const updated = await updateProposal(sql, {
    id,
    status: nextStatus,
    decisionActor: body.actor,
    decisionReason: body.reason,
    decided: true,
  });

  const probes = await listProbes(sql, id);
  const lesson = lessonFromProposal({
    proposal: {
      failureSignature: proposal.failureSignature,
      title: proposal.title,
      summary: proposal.summary,
      files: proposal.files,
      evidence: {
        runIds: (proposal.evidence.runIds as string[] | undefined) ?? [],
        failedRuns: Number(proposal.evidence.failedRuns ?? 0),
        totalRuns: Number(proposal.evidence.totalRuns ?? 0),
        costUsd: Number(proposal.evidence.costUsd ?? 0),
      },
    },
    decision: {
      action: accepted ? 'open_pr' : 'no_improvement',
      code: accepted ? 'human_accepted' : 'human_rejected',
      reason: `${body.actor}: ${body.reason}`,
    },
    probeDelta: probeDeltaOf(probes),
  });

  const lessonId = `lesson_${createHash('sha256')
    .update(`${proposal.factory}\u0000${proposal.id}\u0000${lesson.cue}`)
    .digest('hex')
    .slice(0, 24)}`;
  const stored = await recordLesson(sql, {
    id: lessonId,
    factory: proposal.factory,
    cue: lesson.cue,
    lesson: lesson.lesson,
    evidence: lesson.evidence,
    confidence: lesson.confidence,
    proposalId: proposal.id,
  });
  await appendLessonToLibrary(config, proposal.factory, lesson);

  log('info', 'proposal_decided', {
    proposalId: id,
    decision: body.decision,
    actor: body.actor,
  });
  return { proposal: updated, lesson: stored };
}

export interface ProposalApplyResponse {
  proposal: ProposalRecord;
  decision: { action: string; code: string; reason: string; phase?: string };
  prUrl: string | null;
  prNumber: number | null;
  merged: boolean;
  /** Set when the authority is `canary` and a rollout was started. */
  rollout?: CanaryRolloutRecord;
  workflow?: { workflowId: string; temporalRunId: string } | null;
}

/**
 * Applies an accepted proposal by its recorded authority. `canary` starts a real rollout
 * (Phase 5b): the candidate version is published, new work is routed by deterministic hash
 * and the observation window decides promotion or rollback (ADR-021).
 */
export async function applyProposalForApi(
  config: ApiConfig,
  id: string,
  body: ProposalApplyBody,
): Promise<ProposalApplyResponse> {
  const sql = getSql();
  const proposal = await getProposal(sql, id);
  if (!proposal) throw proposalNotFound(id);
  if (proposal.status === 'pr_open' || proposal.status === 'merged' || proposal.prUrl) {
    return {
      proposal,
      decision: {
        action: proposal.status === 'merged' ? 'merge' : 'open_pr',
        code: 'already_applied',
        reason: 'the proposal was already applied',
      },
      prUrl: proposal.prUrl,
      prNumber: proposal.prNumber,
      merged: proposal.status === 'merged',
    };
  }
  if (proposal.status === 'canary') {
    const inFlight = await getInFlightCanaryRollout(sql, proposal.factory);
    const rollout = inFlight?.proposalId === proposal.id ? inFlight : null;
    return {
      proposal,
      decision: {
        action: 'canary',
        code: 'already_applied',
        reason: 'a canary rollout is already active for this proposal',
      },
      prUrl: null,
      prNumber: null,
      merged: false,
      ...(rollout ? { rollout } : {}),
    };
  }
  if (proposal.status !== 'accepted' && proposal.status !== 'canary_not_available') {
    throw proposalNotAccepted(id, proposal.status);
  }

  if (!proposal.candidateHash || proposal.diff.length === 0) {
    throw new ApiError('no_improvement', 409, 'the proposal has no composed candidate', {
      proposalId: id,
    });
  }

  const probes = await listProbes(sql, id);
  const winner = winningProbe(probes);
  if (!winner) {
    throw new ApiError('no_improvement', 409, 'no probe improved the contrastive signal', {
      proposalId: id,
    });
  }
  const uncalibrated = probes.some(
    (probe) => probe.matchedInputs.uncalibrated === true,
  );

  const applied = await applyImprovementDecision({
    factory: proposal.factory,
    factoryRoot: resolveFactoryDir(config, proposal.factory),
    definitionCommit: pinVersion(resolveFactoryDir(config, proposal.factory), proposal.factory).commit,
    definitionRepo: `${config.definitionRepoOwner}/${proposal.factory}`,
    baseBranch: 'main',
    authority: proposal.authority as (typeof IMPROVEMENT_AUTHORITIES)[number],
    proposal,
    candidateHash: proposal.candidateHash,
    diff: proposal.diff,
    probe: {
      baselineScore: winner.baselineScore,
      candidateScore: winner.candidateScore,
      uncalibrated,
      probeDelta: probeDeltaOf(probes),
    },
  });

  if (applied.decision.action === 'canary') {
    const { dir, definition } = loadFactory(config, proposal.factory);
    const resolved = resolveImprovement(definition.manifest.improvement);
    if (resolved.canaryPercent === null || resolved.rollbackThreshold === null) {
      throw new ApiError(
        'canary_config_missing',
        422,
        'improvement.authority "canary" requires canaryPercent and rollbackThreshold',
        { factory: proposal.factory },
      );
    }
    const { commit } = pinVersion(dir, proposal.factory);
    const started = await startCanaryRollout({
      factory: proposal.factory,
      factoryRoot: dir,
      definitionRepo: `${config.definitionRepoOwner}/${proposal.factory}`,
      baseBranch: 'main',
      proposal,
      stableCommit: commit,
      canaryPercent: resolved.canaryPercent,
      rollbackThreshold: resolved.rollbackThreshold,
      observationWindowHours: resolved.observationWindowHours,
      actor: body.actor,
      reason: body.reason,
    }).catch(canaryApiError);

    const updated = (await getProposal(sql, id)) ?? proposal;
    log('info', 'proposal_applied', {
      proposalId: id,
      authority: proposal.authority,
      action: 'canary',
      rolloutId: started.rollout.id,
      actor: body.actor,
    });

    return {
      proposal: updated,
      decision: {
        action: 'canary',
        code: applied.decision.code,
        reason: applied.decision.reason,
      },
      prUrl: null,
      prNumber: null,
      merged: false,
      rollout: started.rollout,
      workflow: started.workflow,
    };
  }

  const status =
    applied.decision.action === 'merge'
      ? 'merged'
      : applied.decision.action === 'open_pr'
        ? 'pr_open'
        : 'failed';
  const updated = await updateProposal(sql, {
    id,
    status,
    prUrl: applied.prUrl,
    prNumber: applied.prNumber,
    decisionActor: body.actor,
    decisionReason: `${applied.decision.code}: ${applied.decision.reason}`,
    decided: true,
  });

  log('info', 'proposal_applied', {
    proposalId: id,
    authority: proposal.authority,
    action: applied.decision.action,
    actor: body.actor,
  });

  return {
    proposal: updated,
    decision: {
      action: applied.decision.action,
      code: applied.decision.code,
      reason: applied.decision.reason,
      ...(applied.decision.phase ? { phase: applied.decision.phase } : {}),
    },
    prUrl: applied.prUrl,
    prNumber: applied.prNumber,
    merged: applied.merged,
  };
}

/* -------------------------------------------------------------- authority change */

export interface AuthorityChangeResponse {
  confirmationRequired: boolean;
  factory: string;
  from: ReturnType<typeof resolveImprovement>;
  to: ReturnType<typeof resolveImprovement>;
  diff: { pointer: string; old: unknown; new: unknown }[];
  text: string;
  proposal?: ProposalRecord;
  prUrl?: string | null;
  prNumber?: number | null;
}

function manifestWithImprovement(
  manifest: FactoryManifest,
  body: AuthorityChangeBody,
): FactoryManifest {
  const current = manifest.improvement ?? {};
  const next = {
    ...current,
    authority: body.authority,
    ...(body.canaryPercent !== undefined ? { canaryPercent: body.canaryPercent } : {}),
    ...(body.rollbackThreshold !== undefined ? { rollbackThreshold: body.rollbackThreshold } : {}),
  };
  const parsed = factorySchema.safeParse({ ...manifest, improvement: next });
  if (!parsed.success) {
    const issues = mapZodIssues(parsed.error.issues, 'factory.yaml');
    throw new ApiError(
      issues[0]?.code ?? 'invalid_value',
      422,
      'the requested improvement configuration does not validate',
      { issues },
    );
  }
  return parsed.data;
}

/**
 * An authority change is a definition change: the API computes the diff, refuses without
 * `confirm: true`, and then opens a PR against the definition repo. It never writes the
 * worktree (ADR-012).
 */
export async function changeAuthorityForApi(
  config: ApiConfig,
  factory: string,
  body: AuthorityChangeBody,
): Promise<AuthorityChangeResponse> {
  const { definition, commit } = loadFactory(config, factory);
  const from = resolveImprovement(definition.manifest.improvement);
  const nextManifest = manifestWithImprovement(definition.manifest, body);
  const to = resolveImprovement(nextManifest.improvement);

  const diff: AuthorityChangeResponse['diff'] = [];
  const compare = (pointer: string, oldValue: unknown, newValue: unknown): void => {
    if (JSON.stringify(oldValue) !== JSON.stringify(newValue)) {
      diff.push({ pointer, old: oldValue ?? null, new: newValue ?? null });
    }
  };
  compare('/improvement/authority', from.authority, to.authority);
  compare('/improvement/canaryPercent', from.canaryPercent, to.canaryPercent);
  compare('/improvement/rollbackThreshold', from.rollbackThreshold, to.rollbackThreshold);

  const before = canonicalYaml(definition.manifest);
  const after = canonicalYaml(nextManifest);
  const text = [
    `- /improvement/authority: ${from.authority} -> ${to.authority}`,
    ...(JSON.stringify(from.canaryPercent) !== JSON.stringify(to.canaryPercent)
      ? [`- /improvement/canaryPercent: ${from.canaryPercent ?? '(none)'} -> ${to.canaryPercent ?? '(none)'}`]
      : []),
    ...(JSON.stringify(from.rollbackThreshold) !== JSON.stringify(to.rollbackThreshold)
      ? [`- /improvement/rollbackThreshold: ${from.rollbackThreshold ?? '(none)'} -> ${to.rollbackThreshold ?? '(none)'}`]
      : []),
  ].join('\n');

  if (body.confirm !== true) {
    return {
      confirmationRequired: true,
      factory,
      from,
      to,
      diff,
      text,
    };
  }

  if (diff.length === 0) {
    throw invalidRequest('the requested authority is already in effect', { factory });
  }

  const proposalId = `prop_auth_${createHash('sha256')
    .update(`${factory}\u0000${to.authority}\u0000${body.actor}\u0000${commit}`)
    .digest('hex')
    .slice(0, 24)}`;

  const existing = await getProposal(getSql(), proposalId);
  if (existing) {
    // Idempotent: the same authority change (same actor + commit) already has a PR.
    return {
      confirmationRequired: false,
      factory,
      from,
      to,
      diff,
      text,
      proposal: existing,
      prUrl: existing.prUrl,
      prNumber: existing.prNumber,
    };
  }

  const proposal = await createProposal(getSql(), {
    id: proposalId,
    factory,
    kind: 'authority_change',
    authority: to.authority,
    status: 'pr_open',
    title: `Change improvement authority to ${to.authority}`,
    summary: `Authority change requested by ${body.actor}: ${from.authority} → ${to.authority}. ${body.reason}`,
    impact: 0,
    evidence: {
      actor: body.actor,
      reason: body.reason,
      from: from.authority,
      to: to.authority,
      definitionCommit: commit,
    },
    failureSignature: 'authority_change',
    files: ['factory.yaml'],
    diff: [{ path: 'factory.yaml', before, after }],
    clusterKey: `authority:${to.authority}:${body.actor}:${commit}`,
  });

  const repo = { owner: config.definitionRepoOwner, name: factory };
  const forge = getForge();
  const baselineFiles = Object.fromEntries(
    serializeDefinition(definition).map((file) => [file.path, file.content]),
  );
  if (forge instanceof FakeForge) forge.seedRepo(repo, baselineFiles);

  const branch = `authority/${factory}-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
  let prUrl: string | null = null;
  let prNumber: number | null = null;
  try {
    await forge.createBranch({ repo, name: branch, from: 'main' });
    const files: FileChange[] = [{ path: 'factory.yaml', content: after }];
    await forge.commit({
      repo,
      branch,
      message: `factory: improvement authority ${from.authority} → ${to.authority}`,
      files,
    });
    const pull = await forge.openPullRequest({
      repo,
      head: branch,
      base: 'main',
      title: `Improvement authority: ${from.authority} → ${to.authority}`,
      body: [
        `Requested by ${body.actor}.`,
        '',
        body.reason,
        '',
        '```',
        text,
        '```',
        '',
        'This is a definition change; it takes effect for proposals created after it merges.',
      ].join('\n'),
    });
    prUrl = pull.url;
    prNumber = pull.number;
  } catch (error) {
    const code = (error as { code?: string } | null)?.code ?? 'forge_error';
    throw new ApiError(code, 409, error instanceof Error ? error.message : String(error));
  }

  const updated = await updateProposal(getSql(), {
    id: proposal.id,
    prUrl,
    prNumber,
    decisionActor: body.actor,
    decisionReason: body.reason,
    decided: true,
  });

  log('info', 'authority_change_opened', {
    factory,
    from: from.authority,
    to: to.authority,
    actor: body.actor,
    prNumber,
  });

  return {
    confirmationRequired: false,
    factory,
    from,
    to,
    diff,
    text,
    proposal: updated,
    prUrl,
    prNumber,
  };
}

/* --------------------------------------------------------------------- run */

export interface StartedImprovementResponse {
  factory: string;
  improvement: ImprovementRunRecord;
  workflow: { workflowId: string; temporalRunId: string };
}

export async function startImprovementForApi(
  config: ApiConfig,
  factory: string,
  body: ImprovementRunBody,
): Promise<StartedImprovementResponse> {
  const { dir, definition, commit, dirty } = loadFactory(config, factory);
  const resolved = resolveImprovement(definition.manifest.improvement);
  const sql = getSql();

  const improvementRunId = `imp_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`;
  const workflowId = `improvement-${improvementRunId}`;

  const run = await createImprovementRun(sql, {
    id: improvementRunId,
    factory,
    definitionCommit: commit,
    trigger: body.trigger ?? 'on_demand',
    authority: resolved.authority,
    workflowId,
  });

  const input: ImprovementWorkflowInput = {
    improvementRunId,
    factory,
    factoryRoot: dir,
    definitionCommit: commit,
    definitionDirty: dirty,
    trigger: body.trigger ?? 'on_demand',
    authority: resolved.authority,
    canaryPercent: body.canaryPercent ?? resolved.canaryPercent,
    rollbackThreshold: resolved.rollbackThreshold,
    observationWindowHours: resolved.observationWindowHours,
    maxProbes: Math.min(body.maxProbes ?? resolved.maxProbes, resolved.maxProbes),
    minScoredRuns: body.minScoredRuns ?? config.improvementMinScoredRuns,
    windowDays: body.windowDays ?? config.improvementWindowDays,
    maxProposals: config.improvementMaxProposals,
    judgeMode: config.scoringJudgeMode,
    ...(body.runIds ? { runIds: body.runIds } : {}),
    definitionRepo: `${config.definitionRepoOwner}/${factory}`,
    baseBranch: 'main',
  };

  const workflow = await startImprovementWorkflow(input, toOrchestrationConfig(config)).catch(
    async (error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error);
      await finishImprovementRun(sql, {
        id: improvementRunId,
        status: 'error',
        decision: 'error',
        error: `orchestrator_unavailable: ${detail}`,
      }).catch(() => undefined);
      log('error', 'improvement_start_failed', { factory, detail });
      throw new ApiError('orchestrator_unavailable', 503, 'could not start the improvement workflow', {
        improvementRunId,
        error: detail,
      });
    },
  );

  await markImprovementRunning(sql, {
    id: improvementRunId,
    workflowId: workflow.workflowId,
    temporalRunId: workflow.temporalRunId,
  });

  log('info', 'improvement_started', {
    improvementRunId,
    factory,
    authority: resolved.authority,
    trigger: body.trigger ?? 'on_demand',
  });

  return {
    factory,
    improvement: (await getImprovementRun(sql, improvementRunId)) ?? run,
    workflow,
  };
}

export async function getImprovementRunForApi(id: string): Promise<{
  improvement: ImprovementRunRecord;
  proposals: ProposalView[];
  lessons: LessonRecord[];
  events: { type: string; subject: string; payload: Record<string, unknown>; createdAt: string | null }[];
}> {
  const sql = getSql();
  const improvement = await getImprovementRun(sql, id);
  if (!improvement) {
    throw new ApiError('improvement_not_found', 404, `improvement run "${id}" does not exist`, {
      improvementRunId: id,
    });
  }
  const [proposals, lessons, events] = await Promise.all([
    listProposalsForApi({ factory: improvement.factory, limit: 50 }),
    listLessons(sql, { factory: improvement.factory, includeShared: false, limit: 50 }),
    listImprovementEvents(sql, id),
  ]);
  return {
    improvement,
    proposals: proposals.filter((proposal) => proposal.improvementRunId === id),
    lessons,
    events: events.map((event) => ({
      type: event.type,
      subject: event.subject,
      payload: event.payload,
      createdAt: event.createdAt,
    })),
  };
}
