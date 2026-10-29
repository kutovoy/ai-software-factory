import { ApplicationFailure } from '@temporalio/activity';
import {
  SpawnNotAllowedError,
  appendWorkItemEvent,
  compileStageGraph,
  foremanAgentName,
  loadDefinition,
  resolveStageConfigs,
  stageDeclarationsFromDefinition,
  type AgentDef,
} from '@factory/core';
import { getSql } from '../db';
import {
  JUDGEMENT_CLASSIFICATIONS,
  type JudgementClassification,
  type JudgementResult,
  type ReviewFinding,
  type ReviewerReport,
  type ReviewVerdict,
} from '../types';
import { getJudgementModel } from '../models/judgement';
import { getReviewerModel, judgeReviewReports } from '../models/review';

/**
 * Foreman activities.
 *
 * The foreman itself is deterministic workflow control flow (design decision 4). These
 * activities are the boundaries where it touches the definition, a model or the forge:
 * dispatch (`spawnableBy` enforcement), judgement calls (schema-constrained output with
 * retry, then escalation) and the review committee (independent reports + advisory judge).
 */

export interface DispatchStageArgs {
  workItemId: string;
  factory: string;
  factoryRoot: string;
  stage: string;
  /** Agent attempting the dispatch; `null` means the system/API. */
  byAgent: string | null;
  /** Agent declared for the stage; `null` for non-agent stages (e.g. `ship`). */
  targetAgent: string | null;
  attempt: number;
}

export interface DispatchStageResult {
  stage: string;
  agent: string | null;
  spawner: string | null;
}

/**
 * Validates the dispatch against the definition on disk and records the attempt.
 * A spawn outside `spawnableBy` fails with the stable `spawn_not_allowed` code and is
 * recorded as `dispatch.denied` before the failure is raised.
 */
export async function dispatchStage(args: DispatchStageArgs): Promise<DispatchStageResult> {
  const { definition, errors } = loadDefinition(args.factoryRoot);
  if (!definition) {
    throw ApplicationFailure.create({
      type: 'definition_invalid',
      nonRetryable: true,
      message: `factory "${args.factory}" does not validate: ${errors
        .map((error) => `${error.code} ${error.pointer}`)
        .join(', ')}`,
      details: [{ factory: args.factory, errors }],
    });
  }

  const agents = definition.resources
    .filter((resource) => resource.kind === 'agent')
    .map((resource) => ({ name: resource.name, doc: resource.doc as AgentDef }));

  const spawner = args.byAgent ?? foremanAgentName(agents);
  const sql = getSql();

  if (args.targetAgent === null) {
    await appendWorkItemEvent(sql, {
      workItemId: args.workItemId,
      type: 'dispatch.requested',
      stage: args.stage,
      actor: spawner,
      payload: { stage: args.stage, agent: null, attempt: args.attempt },
    });
    return { stage: args.stage, agent: null, spawner };
  }

  const graph = compileStageGraph(stageDeclarationsFromDefinition(definition.manifest, agents));

  try {
    const configs = resolveStageConfigs(graph, {
      manifest: definition.manifest,
      agents,
      spawner,
    });
    const config = configs[args.stage];
    if (!config) {
      throw ApplicationFailure.create({
        type: 'unknown_stage',
        nonRetryable: true,
        message: `stage "${args.stage}" is not part of the compiled graph`,
        details: [{ stage: args.stage, order: graph.order }],
      });
    }
    if (config.agent !== args.targetAgent) {
      throw ApplicationFailure.create({
        type: 'stage_config_mismatch',
        nonRetryable: true,
        message:
          `stage "${args.stage}" runs agent "${config.agent ?? 'none'}", ` +
          `but the workflow dispatched "${args.targetAgent}"`,
        details: [{ stage: args.stage, expected: config.agent, actual: args.targetAgent }],
      });
    }
  } catch (error) {
    if (error instanceof SpawnNotAllowedError) {
      await appendWorkItemEvent(sql, {
        workItemId: args.workItemId,
        type: 'dispatch.denied',
        stage: args.stage,
        actor: spawner,
        payload: {
          stage: args.stage,
          agent: args.targetAgent,
          spawner,
          code: error.code,
          attempt: args.attempt,
        },
      });
      throw ApplicationFailure.create({
        type: 'spawn_not_allowed',
        nonRetryable: true,
        message: error.message,
        details: [
          {
            stage: args.stage,
            agent: args.targetAgent,
            spawner,
            code: error.code,
          },
        ],
      });
    }
    throw error;
  }

  await appendWorkItemEvent(sql, {
    workItemId: args.workItemId,
    type: 'dispatch.requested',
    stage: args.stage,
    actor: spawner,
    payload: { stage: args.stage, agent: args.targetAgent, spawner, attempt: args.attempt },
  });

  return { stage: args.stage, agent: args.targetAgent, spawner };
}

export interface JudgementCallArgs {
  workItemId: string;
  title: string;
  sourceRef: Record<string, unknown>;
  prompt: string;
  /** Invalid output is retried this many times before escalation. Defaults to 3. */
  maxAttempts?: number;
}

/**
 * Schema-constrained judgement call (`implement|spec|wait|reject`).
 *
 * An invalid or failed model response is retried; after the limit the activity records
 * `judgement.escalated` and fails non-retryably so the workflow can route the item to a
 * human gate instead of guessing.
 */
export async function judgementCall(args: JudgementCallArgs): Promise<JudgementResult> {
  const model = getJudgementModel();
  const maxAttempts = Math.min(Math.max(args.maxAttempts ?? 3, 1), 5);
  const sql = getSql();
  const allowed = new Set<string>(JUDGEMENT_CLASSIFICATIONS);

  let lastError = 'unknown judgement error';

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const output = await model.classify({
        workItemId: args.workItemId,
        title: args.title,
        sourceRef: args.sourceRef,
        prompt: args.prompt,
      });
      if (!allowed.has(output.classification)) {
        lastError = `invalid classification "${output.classification}"`;
        await appendWorkItemEvent(sql, {
          workItemId: args.workItemId,
          type: 'judgement.call',
          stage: 'triage',
          actor: model.id,
          payload: { attempt, invalid: true, output, error: lastError },
        });
        continue;
      }

      const classification = output.classification as JudgementClassification;
      const confidence = Number.isFinite(output.confidence)
        ? Math.min(Math.max(output.confidence, 0), 1)
        : 0.5;

      await appendWorkItemEvent(sql, {
        workItemId: args.workItemId,
        type: 'judgement.call',
        stage: 'triage',
        actor: model.id,
        payload: { attempt, classification, confidence, reason: output.reason },
      });

      return {
        classification,
        confidence,
        reason: output.reason,
        attempts: attempt,
        model: model.id,
      };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await appendWorkItemEvent(sql, {
        workItemId: args.workItemId,
        type: 'judgement.call',
        stage: 'triage',
        actor: model.id,
        payload: { attempt, error: lastError },
      });
    }
  }

  await appendWorkItemEvent(sql, {
    workItemId: args.workItemId,
    type: 'judgement.escalated',
    stage: 'triage',
    actor: model.id,
    payload: { attempts: maxAttempts, error: lastError },
  });

  throw ApplicationFailure.create({
    type: 'judgement_invalid',
    nonRetryable: true,
    message: `judgement call returned no valid classification after ${maxAttempts} attempts: ${lastError}`,
    details: [{ workItemId: args.workItemId, attempts: maxAttempts, error: lastError }],
  });
}

export interface ReviewFindingsArgs {
  workItemId: string;
  stage: string;
  reviewerIndex: number;
  runId: string | null;
  runStatus: 'ok' | 'failed' | 'cancelled';
  summary?: string;
}

/** One independent reviewer report. Never posts an approval; findings only. */
export async function reviewFindings(args: ReviewFindingsArgs): Promise<ReviewerReport> {
  const model = getReviewerModel();
  const output = await model.review({
    workItemId: args.workItemId,
    stage: args.stage,
    reviewerIndex: args.reviewerIndex,
    runId: args.runId,
    runStatus: args.runStatus,
    summary: args.summary,
  });

  const reviewer = `reviewer-${args.reviewerIndex}`;
  const findings: ReviewFinding[] = output.findings.map((finding) => ({
    ...finding,
    reviewer: finding.reviewer || reviewer,
  }));

  const report: ReviewerReport = {
    reviewer,
    reviewerIndex: args.reviewerIndex,
    runId: args.runId,
    verdict: output.verdict === 'approve' ? 'approve' : 'reject',
    findings,
    confidence: Math.min(Math.max(output.confidence, 0), 1),
  };

  await appendWorkItemEvent(getSql(), {
    workItemId: args.workItemId,
    type: 'review.verdict',
    stage: args.stage,
    actor: reviewer,
    payload: {
      reviewer: report.reviewer,
      runId: report.runId,
      verdict: report.verdict,
      findings: report.findings,
      confidence: report.confidence,
      advisory: true,
    },
  });

  return report;
}

export interface JudgeReviewsArgs {
  workItemId: string;
  stage: string;
  reports: ReviewerReport[];
  /** Independent reviewers required; fewer reports resolve to `needs_human`. */
  minReviewers: number;
}

/** Merges reviewer reports into one advisory verdict (never an approval, never a merge). */
export async function judgeReviews(args: JudgeReviewsArgs): Promise<ReviewVerdict> {
  const verdict = judgeReviewReports(args.reports, args.minReviewers);

  await appendWorkItemEvent(getSql(), {
    workItemId: args.workItemId,
    type: 'review.verdict',
    stage: args.stage,
    actor: 'judge',
    payload: {
      verdict: verdict.verdict,
      findings: verdict.findings,
      confidence: verdict.confidence,
      reviewers: verdict.reviewers,
      advisory: verdict.advisory,
      ...(verdict.incomplete ? { incomplete: true } : {}),
    },
  });

  return verdict;
}
