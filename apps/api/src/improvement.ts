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
  getImprovementRun,
  getLesson,
  getProposal,
  latestCalibrationResult,
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
  startImprovementWorkflow,
  type ImprovementWorkflowInput,
} from '@factory/orchestration';
import { FakeForge, type FileChange } from '@factory/forge';
import type { ApiConfig } from './config';
import { toOrchestrationConfig } from './config';
import {
  ApiError,
  canaryNotAvailable,
  definitionInvalid,
  invalidRequest,
  lessonNotFound,
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
    actor: z.string().min(1).max(120),
    reason: z.string().min(1).max(2_000),
  })
  .strict();

export type CanaryRollbackBody = z.infer<typeof canaryRollbackBodySchema>;

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
    available: false;
    phase: '5b';
    configuredPercent: number | null;
    rollbackThreshold: number | null;
    observationWindowHours: number;
  };
}

export async function getImprovementForApi(
  config: ApiConfig,
  factory: string,
): Promise<ImprovementOverview> {
  const { definition, commit, dirty } = loadFactory(config, factory);
  const resolved = resolveImprovement(definition.manifest.improvement);
  const sql = getSql();

  const [eligibility, lastRun, proposals, lessons] = await Promise.all([
    eligibilityPreview(config, factory, definition, resolved.authority),
    listImprovementRuns(sql, { factory, limit: 1 }).then((runs) => runs[0] ?? null),
    listProposals(sql, { factory, limit: 10 }),
    listLessons(sql, { factory, includeShared: true, limit: 100 }),
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
      available: false,
      phase: '5b',
      configuredPercent: resolved.canaryPercent,
      rollbackThreshold: resolved.rollbackThreshold,
      observationWindowHours: resolved.observationWindowHours,
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
}

/**
 * Applies an accepted proposal by its recorded authority. `canary` validates the config
 * and refuses with `canary_not_available` (Phase 5b); nothing is routed yet.
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
  if (proposal.status === 'canary_not_available') {
    throw canaryNotAvailable({ proposalId: id, authority: proposal.authority });
  }
  if (proposal.status !== 'accepted') throw proposalNotAccepted(id, proposal.status);

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

  if (applied.decision.action === 'canary_not_available') {
    await updateProposal(sql, {
      id,
      status: 'canary_not_available',
      decisionActor: body.actor,
      decisionReason: `${applied.decision.code}: ${applied.decision.reason}`,
      decided: true,
    });
    throw canaryNotAvailable({
      proposalId: id,
      authority: proposal.authority,
      canaryPercent: resolveImprovement(loadFactory(config, proposal.factory).definition.manifest.improvement)
        .canaryPercent,
    });
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
    canaryPercent: resolved.canaryPercent,
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

/** Phase 5b: canary rollback has no routing to roll back yet; the request is refused. */
export function rollbackCanaryForApi(body: CanaryRollbackBody): never {
  throw canaryNotAvailable({
    factory: body.factory,
    proposalId: body.proposalId ?? null,
    actor: body.actor,
    reason: body.reason,
  });
}
