import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApplicationFailure } from '@temporalio/activity';
import {
  appendLessonFiles,
  assessEligibility,
  clusterKeyOf,
  composeCandidate,
  createDeterministicProbeRunner,
  dedupeProposals,
  guardEdits,
  lessonFromProposal,
  loadScorerRegistry,
  observeScoredCorpus,
  runContrastiveProbe,
  statusForDecision,
  type ComposedCandidate,
  type ImprovementDecision,
  type ObservedEdit,
  type ObservedProposal,
  type ProbeRunner,
  type ProbeSide,
  type ScoredRunEvidence,
} from '@factory/evals';
import {
  createImprovementRun,
  createProposal,
  finishImprovementRun,
  getInFlightCanaryRollout,
  getImprovementRun,
  getProposal,
  latestCalibrationResult,
  listProposalEdits,
  listScores,
  loadDefinition,
  markImprovementRunning,
  parseStageRunId,
  recordImprovementEvent,
  recordLesson,
  recordProbe,
  recordProposalEdit,
  rejectProposalEdit,
  updateProposal,
  type FactoryDefinition,
  type ImprovementRunRecord,
  type ProposalEditRecord,
  type ProposalRecord,
} from '@factory/core';
import { loadConfig } from '../config';
import { getSql } from '../db';
import { applyImprovementDecision } from '../improvement-apply';
import { startCanaryRollout } from '../canary-apply';
import type {
  ImprovementProposalOutcome,
  ImprovementWorkflowInput,
} from '../types';

/**
 * Self-improvement activities (Phase 5, spec `self-improvement`, ADR-020).
 *
 * eligibility → observe → dedupe → probe → compose → decide → lessons.
 *
 * Everything is deterministic and credential-free: the observer is a pure function over the
 * scored corpus, the probe uses an injected hook (deterministic by default), and the forge
 * is the fake backend in CI. No model is called.
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

let probeRunnerOverride: ProbeRunner | null = null;

/** Test hook: inject a scripted probe runner without a model or network. */
export function setImprovementProbeRunner(runner: ProbeRunner | null): void {
  probeRunnerOverride = runner;
}

function probeRunner(): ProbeRunner {
  return probeRunnerOverride ?? createDeterministicProbeRunner();
}

function requireDefinition(factoryRoot: string, factory: string): FactoryDefinition {
  const { definition, errors } = loadDefinition(factoryRoot);
  if (!definition) {
    fail(
      'definition_invalid',
      `improvement cannot load the definition for "${factory}": ${errors
        .map((error) => `${error.code} ${error.pointer}`)
        .join(', ')}`,
      { factory, errors },
    );
  }
  return definition;
}

/* ------------------------------------------------------------ run lifecycle */

export async function startImprovementRunActivity(args: {
  input: ImprovementWorkflowInput;
  workflowId?: string | null;
}): Promise<ImprovementRunRecord> {
  return await createImprovementRun(getSql(), {
    id: args.input.improvementRunId,
    factory: args.input.factory,
    definitionCommit: args.input.definitionCommit,
    trigger: args.input.trigger,
    authority: args.input.authority,
    workflowId: args.workflowId ?? null,
  });
}

export async function markImprovementRunningActivity(args: {
  improvementRunId: string;
  workflowId?: string | null;
  temporalRunId?: string | null;
}): Promise<ImprovementRunRecord> {
  return await markImprovementRunning(getSql(), {
    id: args.improvementRunId,
    workflowId: args.workflowId ?? null,
    temporalRunId: args.temporalRunId ?? null,
  });
}

export async function finishImprovementRunActivity(args: {
  improvementRunId: string;
  status: 'completed' | 'error' | 'skipped';
  eligibility?: Record<string, unknown>;
  proposals?: number;
  lessons?: number;
  decision?: string | null;
  error?: string | null;
}): Promise<ImprovementRunRecord> {
  return await finishImprovementRun(getSql(), {
    id: args.improvementRunId,
    status: args.status,
    ...(args.eligibility === undefined ? {} : { eligibility: args.eligibility }),
    proposals: args.proposals,
    lessons: args.lessons,
    decision: args.decision ?? null,
    error: args.error ?? null,
  });
}

export async function recordImprovementEventActivity(args: {
  improvementRunId: string;
  factory: string;
  type: string;
  subject?: string;
  payload?: Record<string, unknown>;
}): Promise<{ appended: boolean }> {
  const result = await recordImprovementEvent(getSql(), args);
  return { appended: result.appended };
}

/* ------------------------------------------------------------- eligibility */

interface RunCorpusRow {
  id: string;
  factory: string;
  status: string;
  input: unknown;
  cost_usd: unknown;
  title: string | null;
}

function promptHashOf(row: RunCorpusRow): string {
  const input = (row.input ?? {}) as { prompt?: { text?: string }; title?: string };
  const text = input.prompt?.text ?? row.title ?? row.id;
  return createHash('sha256').update(String(text)).digest('hex');
}

function terminalStatus(value: string): ScoredRunEvidence['status'] {
  if (value === 'ok') return 'ok';
  if (value === 'cancelled') return 'cancelled';
  return 'error';
}

/** Reads the scored corpus: terminal runs in the window that carry at least one score. */
async function readScoredCorpus(
  factory: string,
  windowDays: number,
  runIds?: string[],
): Promise<ScoredRunEvidence[]> {
  const sql = getSql();
  const from = new Date(Date.now() - Math.max(1, windowDays) * 24 * 60 * 60 * 1000).toISOString();

  let rows: RunCorpusRow[];
  if (runIds && runIds.length > 0) {
    rows = [];
    for (const runId of runIds.slice(0, 200)) {
      const found = (await sql`
        select id, factory, status, input, cost_usd, title
        from runs where id = ${runId} limit 1
      `) as RunCorpusRow[];
      if (found[0]) rows.push(found[0]);
    }
  } else {
    rows = (await sql`
      select id, factory, status, input, cost_usd, title
      from runs
      where factory = ${factory}
        and status in ('ok', 'error', 'cancelled')
        and started_at >= ${from}::timestamptz
      order by started_at desc
      limit 200
    `) as RunCorpusRow[];
  }

  const scores = await listScores(sql, {
    factory,
    since: runIds && runIds.length > 0 ? undefined : from,
    limit: 500,
  });
  const scoresByRun = new Map<string, typeof scores>();
  for (const score of scores) {
    const bucket = scoresByRun.get(score.runId);
    if (bucket) bucket.push(score);
    else scoresByRun.set(score.runId, [score]);
  }

  const corpus: ScoredRunEvidence[] = [];
  for (const row of rows) {
    const runScores = scoresByRun.get(row.id) ?? [];
    if (runScores.length === 0) continue;
    const parsed = parseStageRunId(row.id);
    const costUsd =
      Number(row.cost_usd ?? 0) +
      runScores.reduce((total, score) => total + (score.provenance.costUsd ?? 0), 0);
    corpus.push({
      runId: row.id,
      workItemId: parsed?.workItemId ?? null,
      stage: parsed?.stage ?? null,
      status: terminalStatus(row.status),
      promptHash: promptHashOf(row),
      costUsd: Math.round(costUsd * 1_000_000) / 1_000_000,
      scores: runScores.map((score) => ({
        scorer: score.scorer,
        scorerClass: score.scorerClass,
        status: score.status,
        label: score.label,
        score: score.score,
        passing: score.passing,
        errorCode: score.errorCode,
        rationale: score.rationale,
        rubricHash: score.rubricHash,
        uncalibrated: score.uncalibrated,
      })),
    });
  }

  return corpus;
}

export interface ImprovementEligibilityResult {
  eligibility: ReturnType<typeof assessEligibility>;
  corpus: ScoredRunEvidence[];
}

export async function assessImprovementEligibilityActivity(args: {
  input: ImprovementWorkflowInput;
}): Promise<ImprovementEligibilityResult> {
  const { input } = args;
  const definition = requireDefinition(input.factoryRoot, input.factory);
  const registry = loadScorerRegistry(definition);
  const sql = getSql();

  const judges: {
    scorer: string;
    rubricHash: string;
    judgeModel: string;
    calibrated: boolean;
  }[] = [];
  for (const scorer of registry.filter((entry) => entry.scorerClass === 'judge')) {
    const result = await latestCalibrationResult(sql, {
      factory: input.factory,
      scorer: scorer.name,
      rubricHash: scorer.rubricHash,
      judgeModel: scorer.judgeModel,
    });
    judges.push({
      scorer: scorer.name,
      rubricHash: scorer.rubricHash,
      judgeModel: scorer.judgeModel,
      calibrated: result?.verdict === 'pass',
    });
  }

  const corpus = await readScoredCorpus(input.factory, input.windowDays, input.runIds);
  const eligibility = assessEligibility({
    authority: input.authority,
    minScoredRuns: input.minScoredRuns,
    scoredRuns: corpus.length,
    judges,
  });
  return { eligibility, corpus };
}

/* ------------------------------------------------------------- observation */

export async function observeImprovementActivity(args: {
  input: ImprovementWorkflowInput;
  corpus: ScoredRunEvidence[];
}): Promise<ObservedProposal[]> {
  const definition = requireDefinition(args.input.factoryRoot, args.input.factory);
  const observed = observeScoredCorpus(definition, args.corpus, {
    maxProposals: args.input.maxProposals,
  });
  return dedupeProposals(observed).slice(0, Math.max(1, args.input.maxProposals));
}

export interface PersistedProposal {
  proposal: ProposalRecord;
  edits: ProposalEditRecord[];
  /** Edits rejected by the blast-radius guard (recorded, never composed). */
  outOfScope: { path: string; code: string; message: string }[];
}

function proposalIdFor(runId: string, clusterKey: string): string {
  return `prop_${createHash('sha256')
    .update(`${runId}\u0000${clusterKey}`)
    .digest('hex')
    .slice(0, 24)}`;
}

function editIdFor(proposalId: string, kind: string, path: string): string {
  return `edit_${createHash('sha256')
    .update(`${proposalId}\u0000${kind}\u0000${path}`)
    .digest('hex')
    .slice(0, 24)}`;
}

/**
 * Persists the deduped proposals and their edits. Every out-of-scope attempt is recorded
 * with `edit_out_of_scope` (spec: Blast radius); a proposal left with no in-scope edit is
 * rejected rather than probed.
 */
export async function persistImprovementProposalsActivity(args: {
  input: ImprovementWorkflowInput;
  proposals: ObservedProposal[];
}): Promise<PersistedProposal[]> {
  const sql = getSql();
  const persisted: PersistedProposal[] = [];

  for (const proposal of args.proposals) {
    const key = clusterKeyOf(proposal);
    const proposalId = proposalIdFor(args.input.improvementRunId, key);
    const guarded = guardEdits(proposal.edits);
    const status = guarded.inScope.length === 0 ? 'rejected' : 'open';

    const row = await createProposal(sql, {
      id: proposalId,
      improvementRunId: args.input.improvementRunId,
      factory: args.input.factory,
      authority: args.input.authority,
      status,
      title: proposal.title,
      summary: proposal.summary,
      impact: proposal.impact,
      evidence: proposal.evidence as unknown as Record<string, unknown>,
      failureSignature: proposal.failureSignature,
      files: proposal.files,
      clusterKey: key,
      ...(status === 'rejected'
        ? {
            decisionActor: 'observer',
            decisionReason: 'edit_out_of_scope',
          }
        : {}),
    });

    const edits: ProposalEditRecord[] = [];
    for (const edit of proposal.edits) {
      const violation = guarded.outOfScope.find((entry) => entry.path === edit.path);
      edits.push(
        await recordProposalEdit(sql, {
          id: editIdFor(proposalId, edit.kind, edit.path),
          proposalId,
          kind: edit.kind,
          path: edit.path,
          rationale: edit.rationale,
          content: edit.content,
          scope: violation ? 'out_of_scope' : 'in_scope',
          rejected: Boolean(violation),
          rejectionCode: violation?.code ?? null,
        }),
      );
    }

    if (status === 'rejected') {
      await updateProposal(sql, {
        id: proposalId,
        status: 'rejected',
        decisionActor: 'observer',
        decisionReason: 'edit_out_of_scope',
        decided: true,
      });
    }

    await recordImprovementEvent(sql, {
      improvementRunId: args.input.improvementRunId,
      factory: args.input.factory,
      type: 'proposal.created',
      subject: proposalId,
      payload: {
        proposalId,
        failureSignature: proposal.failureSignature,
        impact: proposal.impact,
        status,
        files: proposal.files,
        rejected: guarded.outOfScope,
      },
    });

    persisted.push({ proposal: row, edits, outOfScope: guarded.outOfScope });
  }

  return persisted;
}

/* ----------------------------------------------------------------- probing */

export interface ImprovementProbeResult {
  proposalId: string;
  winners: string[];
  probes: {
    editId: string;
    editPath: string;
    kind: string;
    baselineScore: number | null;
    candidateScore: number | null;
    delta: number | null;
    winner: boolean;
    uncalibrated: boolean;
  }[];
  rejected: { path: string; code: string }[];
  noSignal: boolean;
  probeDelta: number | null;
  probeUncalibrated: boolean;
  baselineScore: number | null;
  candidateScore: number | null;
}

async function baselineForProposal(proposal: ProposalRecord): Promise<{
  side: ProbeSide;
  workItem: {
    workItemId: string | null;
    runId: string;
    promptHash: string;
    scorer: string;
    rubricHash: string;
  };
}> {
  const sql = getSql();
  const evidenceRunIds = (proposal.evidence.runIds as string[] | undefined) ?? [];
  const runId = evidenceRunIds[0];
  if (typeof runId !== 'string' || runId.length === 0) {
    fail('proposal_without_evidence', `proposal ${proposal.id} cites no source run`, {
      proposalId: proposal.id,
    });
  }

  const rows = (await sql`
    select id, status, input, title from runs where id = ${runId} limit 1
  `) as { id: string; status: string; input: unknown; title: string | null }[];
  const run = rows[0];
  if (!run) fail('run_not_found', `source run "${runId}" does not exist`, { runId });

  const scores = await listScores(sql, { factory: proposal.factory, runId, limit: 50 });
  const failing = scores.find(
    (score) => score.status === 'error' || (score.status === 'ok' && !score.passing),
  );
  const score = failing ?? scores[0] ?? null;
  const parsed = parseStageRunId(runId);
  const promptHash = promptHashOf({
    id: run.id,
    factory: proposal.factory,
    status: run.status,
    input: run.input,
    cost_usd: 0,
    title: run.title,
  });

  const workItem = {
    workItemId: parsed?.workItemId ?? null,
    runId,
    promptHash,
    scorer: score?.scorer ?? 'run',
    rubricHash: score?.rubricHash ?? '',
  };

  const identity = {
    workItemId: workItem.workItemId,
    runId,
    promptHash,
    scorer: workItem.scorer,
    rubricHash: workItem.rubricHash,
  };

  const baselineScore =
    run.status !== 'ok' ? 0 : (failing?.score ?? (failing ? 0 : 1));
  const side: ProbeSide = {
    identity,
    status: run.status,
    score: baselineScore,
    passing: run.status === 'ok' && !failing,
    uncalibrated: failing?.uncalibrated ?? false,
  };
  return { side, workItem };
}

/**
 * Runs one contrastive probe per surviving edit, on the same work item as the baseline,
 * and records the per-edit outcome. Losing edits are rejected with `no_signal`.
 */
export async function probeImprovementActivity(args: {
  input: ImprovementWorkflowInput;
  proposalIds: string[];
}): Promise<ImprovementProbeResult[]> {
  const sql = getSql();
  const runner = probeRunner();
  const results: ImprovementProbeResult[] = [];

  for (const proposalId of args.proposalIds.slice(0, Math.max(1, args.input.maxProbes))) {
    const proposal = await getProposal(sql, proposalId);
    if (!proposal) continue;
    if (proposal.status === 'rejected' || proposal.status === 'no_improvement') continue;

    const edits = (await listProposalEdits(sql, proposalId)).filter(
      (edit) => edit.scope === 'in_scope' && !edit.rejected,
    );
    if (edits.length === 0) continue;

    const { side, workItem } = await baselineForProposal(proposal);
    const probes: ImprovementProbeResult['probes'] = [];
    const rejected: { path: string; code: string }[] = [];
    const winners: string[] = [];

    for (const edit of edits) {
      const candidate = runner({
        edit: { kind: edit.kind, path: edit.path },
        workItem,
        baseline: side,
      });
      const result = runContrastiveProbe({
        edit: { kind: edit.kind, path: edit.path },
        workItem,
        baseline: side,
        candidate,
      });
      const uncalibrated = side.uncalibrated || candidate.uncalibrated;

      await recordProbe(sql, {
        id: `probe_${createHash('sha256')
          .update(`${proposalId}\u0000${edit.id}\u0000${workItem.workItemId ?? workItem.runId}`)
          .digest('hex')
          .slice(0, 24)}`,
        proposalId,
        editId: edit.id,
        workItemId: workItem.workItemId ?? workItem.runId,
        runId: workItem.runId,
        matchedInputs: { ...result.matchedInputs, uncalibrated },
        baselineScore: result.baselineScore,
        candidateScore: result.candidateScore,
        delta: result.delta,
        winner: result.winner,
      });

      if (result.winner) {
        winners.push(edit.id);
      } else {
        rejected.push({ path: edit.path, code: 'no_signal' });
        await rejectProposalEdit(sql, {
          id: edit.id,
          rejectionCode: 'no_signal',
          contrast: { ...result.matchedInputs, delta: result.delta, winner: false },
        });
      }

      probes.push({
        editId: edit.id,
        editPath: edit.path,
        kind: edit.kind,
        baselineScore: result.baselineScore,
        candidateScore: result.candidateScore,
        delta: result.delta,
        winner: result.winner,
        uncalibrated,
      });
    }

    const winning = probes.filter((probe) => probe.winner);
    const probeDelta =
      winning.length === 0
        ? null
        : Math.max(...winning.map((probe) => probe.delta ?? 0));
    const probeUncalibrated = probes.some((probe) => probe.uncalibrated);

    await recordImprovementEvent(sql, {
      improvementRunId: args.input.improvementRunId,
      factory: args.input.factory,
      type: 'probe.completed',
      subject: proposalId,
      payload: {
        proposalId,
        winners: winners.length,
        rejected,
        probeDelta,
        uncalibrated: probeUncalibrated,
      },
    });

    results.push({
      proposalId,
      winners,
      probes,
      rejected,
      noSignal: winners.length === 0,
      probeDelta,
      probeUncalibrated,
      baselineScore: probes[0]?.baselineScore ?? null,
      candidateScore: probeDelta === null ? null : (probes.find((probe) => probe.winner)?.candidateScore ?? null),
    });
  }

  return results;
}

/* ---------------------------------------------------------------- compose */

export interface ComposedImprovement {
  proposalId: string;
  candidateHash: string;
  changedPaths: string[];
  diff: ComposedCandidate['diff'];
  probeDelta: number | null;
  probeUncalibrated: boolean;
  baselineScore: number | null;
  candidateScore: number | null;
}

function validateCandidate(files: { path: string; content: string }[], factory: string): void {
  const dir = mkdtempSync(join(tmpdir(), 'factory-improve-candidate-'));
  try {
    for (const file of files) {
      const absolute = join(dir, file.path);
      mkdirSync(join(absolute, '..'), { recursive: true });
      writeFileSync(absolute, file.content);
    }
    const { definition, errors } = loadDefinition(dir);
    if (!definition) {
      fail(
        'candidate_invalid',
        `composed candidate for "${factory}" does not validate: ${errors
          .map((error) => `${error.code} ${error.pointer}`)
          .join(', ')}`,
        { factory, errors },
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function toObservedEdit(edit: ProposalEditRecord): ObservedEdit {
  return {
    kind: edit.kind,
    path: edit.path,
    rationale: edit.rationale,
    content: edit.content,
  };
}

/**
 * Composes winning edits into one candidate definition, validates it by loading a scratch
 * tree, records the diff + content hash, and closes proposals with no signal as
 * `no_improvement`.
 */
export async function composeImprovementActivity(args: {
  input: ImprovementWorkflowInput;
  probeResults: ImprovementProbeResult[];
}): Promise<ComposedImprovement[]> {
  const sql = getSql();
  const definition = requireDefinition(args.input.factoryRoot, args.input.factory);
  const composed: ComposedImprovement[] = [];

  for (const probe of args.probeResults) {
    const proposal = await getProposal(sql, probe.proposalId);
    if (!proposal) continue;

    if (probe.noSignal) {
      await updateProposal(sql, {
        id: proposal.id,
        status: 'no_improvement',
        decisionActor: 'observer',
        decisionReason: 'no_improvement',
        decided: true,
      });
      continue;
    }

    const edits = (await listProposalEdits(sql, proposal.id)).filter(
      (edit) => probe.winners.includes(edit.id) && edit.scope === 'in_scope' && !edit.rejected,
    );
    if (edits.length === 0) continue;

    let candidate: ComposedCandidate;
    try {
      candidate = composeCandidate(definition, edits.map(toObservedEdit));
      validateCandidate(candidate.files, args.input.factory);
    } catch (error) {
      await updateProposal(sql, {
        id: proposal.id,
        status: 'failed',
        decisionActor: 'observer',
        decisionReason: message(error),
        decided: true,
      });
      continue;
    }

    await updateProposal(sql, {
      id: proposal.id,
      status: 'open',
      diff: candidate.diff,
      candidateHash: candidate.candidateHash,
    });

    await recordImprovementEvent(sql, {
      improvementRunId: args.input.improvementRunId,
      factory: args.input.factory,
      type: 'candidate.published',
      subject: proposal.id,
      payload: {
        proposalId: proposal.id,
        candidateHash: candidate.candidateHash,
        changedPaths: candidate.changedPaths,
        probeDelta: probe.probeDelta,
      },
    });

    composed.push({
      proposalId: proposal.id,
      candidateHash: candidate.candidateHash,
      changedPaths: candidate.changedPaths,
      diff: candidate.diff,
      probeDelta: probe.probeDelta,
      probeUncalibrated: probe.probeUncalibrated,
      baselineScore: probe.baselineScore,
      candidateScore: probe.candidateScore,
    });
  }

  return composed;
}

/* ------------------------------------------------------------------ decide */

export interface ImprovementDecisionResult {
  proposalId: string;
  action: ImprovementDecision['action'];
  code: string;
  reason: string;
  phase?: '5b';
  prUrl: string | null;
  prNumber: number | null;
  merged: boolean;
  /** Set when the authority is `canary` and a rollout was started. */
  rolloutId?: string;
  candidateVersion?: string;
  stableVersion?: string;
}

/**
 * Applies each composed candidate by authority. The shared helper opens a PR for
 * `propose_only`, merges only on benchmark non-regression for
 * `auto_merge_on_benchmark`, and for `canary` starts a real rollout: the candidate version
 * is published by `CanaryWorkflow`, which then routes new work by deterministic hash and
 * observes it (Phase 5b, ADR-021).
 */
export async function decideImprovementActivity(args: {
  input: ImprovementWorkflowInput;
  composed: ComposedImprovement[];
}): Promise<ImprovementDecisionResult[]> {
  const sql = getSql();
  const results: ImprovementDecisionResult[] = [];

  for (const composed of args.composed) {
    const proposal = await getProposal(sql, composed.proposalId);
    if (!proposal) continue;

    let applied: Awaited<ReturnType<typeof applyImprovementDecision>>;
    try {
      applied = await applyImprovementDecision({
        factory: args.input.factory,
        factoryRoot: args.input.factoryRoot,
        definitionCommit: args.input.definitionCommit,
        definitionRepo: args.input.definitionRepo,
        ...(args.input.baseBranch ? { baseBranch: args.input.baseBranch } : {}),
        authority: args.input.authority,
        proposal,
        candidateHash: composed.candidateHash,
        diff: composed.diff,
        probe: {
          baselineScore: composed.baselineScore,
          candidateScore: composed.candidateScore,
          uncalibrated: composed.probeUncalibrated,
          probeDelta: composed.probeDelta,
        },
      });
    } catch (error) {
      const code = (error as { code?: string } | null)?.code ?? 'forge_error';
      await updateProposal(sql, {
        id: proposal.id,
        status: 'failed',
        decisionActor: 'improvement-observer',
        decisionReason: `${code}: ${message(error)}`,
        decided: true,
      });
      results.push({
        proposalId: proposal.id,
        action: 'open_pr',
        code,
        reason: message(error),
        prUrl: null,
        prNumber: null,
        merged: false,
      });
      continue;
    }

    if (applied.decision.action === 'canary') {
      if (args.input.canaryPercent === null || args.input.rollbackThreshold === null) {
        fail(
          'canary_config_missing',
          'authority "canary" requires canaryPercent and rollbackThreshold',
          { proposalId: proposal.id },
        );
      }
      // One active rollout per factory (ADR-021): the first (highest-impact) candidate owns
      // it; the rest stay open for a later rollout once this one finishes. Reading the
      // active row keeps this idempotent across activity retries.
      const active = await getInFlightCanaryRollout(sql, args.input.factory);
      if (active && active.proposalId !== proposal.id) {
        await updateProposal(sql, {
          id: proposal.id,
          decisionActor: 'improvement-observer',
          decisionReason: `canary_active: rollout ${active.id} already routes this factory`,
        });
        results.push({
          proposalId: proposal.id,
          action: applied.decision.action,
          code: 'canary_active',
          reason: `rollout ${active.id} already routes this factory`,
          prUrl: null,
          prNumber: null,
          merged: false,
        });
        continue;
      }

      try {
        const started = await startCanaryRollout({
          factory: args.input.factory,
          factoryRoot: args.input.factoryRoot,
          definitionRepo: args.input.definitionRepo,
          ...(args.input.baseBranch ? { baseBranch: args.input.baseBranch } : {}),
          proposal,
          stableCommit: args.input.definitionCommit,
          canaryPercent: args.input.canaryPercent,
          rollbackThreshold: args.input.rollbackThreshold,
          observationWindowHours: args.input.observationWindowHours,
          actor: 'improvement-observer',
          reason: `${applied.decision.code}: ${applied.decision.reason}`,
        });
        results.push({
          proposalId: proposal.id,
          action: applied.decision.action,
          code: applied.decision.code,
          reason: applied.decision.reason,
          prUrl: null,
          prNumber: null,
          merged: false,
          rolloutId: started.rollout.id,
          candidateVersion: started.rollout.candidateVersion,
          stableVersion: started.rollout.stableVersion,
        });
      } catch (error) {
        const code = (error as { code?: string } | null)?.code ?? 'canary_error';
        await updateProposal(sql, {
          id: proposal.id,
          status: 'failed',
          decisionActor: 'improvement-observer',
          decisionReason: `${code}: ${message(error)}`,
          decided: true,
        });
        results.push({
          proposalId: proposal.id,
          action: applied.decision.action,
          code,
          reason: message(error),
          prUrl: null,
          prNumber: null,
          merged: false,
        });
      }
      continue;
    }

    const { decision, prUrl, prNumber, merged } = applied;
    await updateProposal(sql, {
      id: proposal.id,
      status: statusForDecision(decision.action) as ProposalRecord['status'],
      prUrl,
      prNumber,
      decisionActor: 'improvement-observer',
      decisionReason: `${decision.code}: ${decision.reason}`,
      decided: true,
    });

    results.push({
      proposalId: proposal.id,
      action: decision.action,
      code: decision.code,
      reason: decision.reason,
      ...(decision.phase ? { phase: decision.phase } : {}),
      prUrl,
      prNumber,
      merged,
    });
  }

  return results;
}

/* ----------------------------------------------------------------- lessons */

function experienceDir(factory: string): string {
  // The definition tree is mounted read-only in compose; the experience library is a
  // projection written next to run artifacts, per factory.
  return join(loadConfig().runsDir, 'experience', factory);
}

function readIfExists(path: string): string | null {
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

/**
 * Appends one lesson per decided proposal to the per-factory experience library
 * (`INDEX.md` + `EXPERIENCE.md`) and mirrors it in the `lessons` table. Promotion to the
 * shared library is a separate, explicit human action (API `POST /lessons/:id/promote`).
 */
export async function recordImprovementLessonsActivity(args: {
  input: ImprovementWorkflowInput;
  proposals: ProposalRecord[];
  decisions: ImprovementDecisionResult[];
  probeResults: ImprovementProbeResult[];
}): Promise<string[]> {
  const sql = getSql();
  const dir = experienceDir(args.input.factory);
  mkdirSync(dir, { recursive: true });
  const index = readIfExists(join(dir, 'INDEX.md'));
  const experience = readIfExists(join(dir, 'EXPERIENCE.md'));

  let nextIndex = index;
  let nextExperience = experience;
  const ids: string[] = [];

  for (const proposal of args.proposals) {
    const decision = args.decisions.find((entry) => entry.proposalId === proposal.id);
    if (!decision) continue;
    const probe = args.probeResults.find((entry) => entry.proposalId === proposal.id);
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
        action: decision.action,
        code: decision.code,
        reason: decision.reason,
        ...(decision.phase ? { phase: decision.phase } : {}),
      },
      probeDelta: probe?.probeDelta ?? null,
    });

    const id = `lesson_${createHash('sha256')
      .update(`${args.input.factory}\u0000${proposal.id}\u0000${lesson.cue}`)
      .digest('hex')
      .slice(0, 24)}`;
    const stored = await recordLesson(sql, {
      id,
      factory: args.input.factory,
      cue: lesson.cue,
      lesson: lesson.lesson,
      evidence: lesson.evidence,
      confidence: lesson.confidence,
      proposalId: proposal.id,
    });
    ids.push(stored.id);

    const appended = appendLessonFiles({
      factory: args.input.factory,
      index: nextIndex,
      experience: nextExperience,
      lesson,
    });
    nextIndex = appended.index;
    nextExperience = appended.experience;
  }

  if (nextIndex !== null) writeFileSync(join(dir, 'INDEX.md'), nextIndex);
  if (nextExperience !== null) writeFileSync(join(dir, 'EXPERIENCE.md'), nextExperience);
  return ids;
}

/* -------------------------------------------------------------- diagnostics */

export async function getImprovementRunActivity(args: {
  improvementRunId: string;
}): Promise<ImprovementRunRecord | null> {
  return await getImprovementRun(getSql(), args.improvementRunId);
}

export async function getProposalRecordsActivity(args: {
  proposalIds: string[];
}): Promise<ProposalRecord[]> {
  const sql = getSql();
  const proposals: ProposalRecord[] = [];
  for (const id of args.proposalIds) {
    const proposal = await getProposal(sql, id);
    if (proposal) proposals.push(proposal);
  }
  return proposals;
}

export async function summarizeImprovementProposalsActivity(args: {
  proposalIds: string[];
  probeResults: ImprovementProbeResult[];
}): Promise<ImprovementProposalOutcome[]> {
  const sql = getSql();
  const outcomes: ImprovementProposalOutcome[] = [];
  for (const id of args.proposalIds) {
    const proposal = await getProposal(sql, id);
    if (!proposal) continue;
    outcomes.push(summarizeProposalOutcome(proposal, args.probeResults));
  }
  return outcomes;
}

export function summarizeProposalOutcome(
  proposal: ProposalRecord,
  probeResults: ImprovementProbeResult[],
): ImprovementProposalOutcome {
  const probe = probeResults.find((entry) => entry.proposalId === proposal.id);
  return {
    proposalId: proposal.id,
    title: proposal.title,
    failureSignature: proposal.failureSignature,
    impact: proposal.impact,
    status: proposal.status,
    candidateHash: proposal.candidateHash,
    prUrl: proposal.prUrl,
    prNumber: proposal.prNumber,
    probes: (probe?.probes ?? []).map((entry) => ({
      editPath: entry.editPath,
      kind: entry.kind,
      delta: entry.delta,
      winner: entry.winner,
    })),
    rejected: probe?.rejected ?? [],
  };
}
