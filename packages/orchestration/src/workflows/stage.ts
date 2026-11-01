import {
  condition,
  defineSignal,
  defineUpdate,
  executeChild,
  proxyActivities,
  setHandler,
  workflowInfo,
} from '@temporalio/workflow';
import type * as activities from '../activities';
import type {
  GateDecisionAck,
  GateDecisionInput,
  RunInput,
  RunOutcome,
  StageGateOutcome,
  StageWorkflowInput,
  StageWorkflowResult,
} from '../types';
import { runWorkflowIdFor, stageRunId } from '../types';
import { RunWorkflow } from './run';

/**
 * StageWorkflow — one child workflow per stage attempt.
 *
 * Phases:
 *   - `run`    — runs the stage agent (child `RunWorkflow`), then the stage gate;
 *   - `review` — one independent reviewer: runs on the same commit and returns findings
 *                (the gate is decided by the parent after the judge merges reports);
 *   - `gate`   — gate only (the `ship` stage and the review committee's final gate).
 *
 * Gate waits reuse ADR-013: the Update (`submitGateDecision`) / Signal (`gateDecision`)
 * handlers are registered before the first await, then the workflow waits on workflow
 * state with `condition()`. No activity slot is held while a human thinks. Only the SLA
 * timer and the decision write touch the database. SLA fallback: auto-reject unless the
 * autonomy policy + benchmark gate allow an auto-approve (spec: durable gates with SLA).
 */

const gates = proxyActivities<typeof activities>({
  startToCloseTimeout: '1 minute',
  retry: {
    initialInterval: '500ms',
    backoffCoefficient: 2,
    maximumInterval: '10 seconds',
    maximumAttempts: 10,
  },
});

const foreman = proxyActivities<typeof activities>({
  startToCloseTimeout: '10 minutes',
  retry: {
    initialInterval: '1 second',
    backoffCoefficient: 2,
    maximumInterval: '30 seconds',
    maximumAttempts: 5,
  },
});

/** Preferred gate channel: a Temporal Update with a synchronous acknowledgement. */
export const submitGateDecisionUpdate = defineUpdate<GateDecisionAck, [GateDecisionInput]>(
  'submitGateDecision',
);

/** Fallback gate channel for clients that cannot use Updates. */
export const gateDecisionSignal = defineSignal<[GateDecisionInput]>('gateDecision');

/** Default SLA for an undecided gate. */
export const DEFAULT_GATE_SLA_MS = 24 * 60 * 60 * 1000;

/** How often a durable gate wait wakes to re-check its deadline. */
const GATE_WAIT_SLICE_MS = 60 * 1000;

export async function StageWorkflow(input: StageWorkflowInput): Promise<StageWorkflowResult> {
  let decision: GateDecisionInput | null = null;

  const currentDecision = (): GateDecisionInput | null => decision;

  const accept = (payload: GateDecisionInput): GateDecisionAck => {
    const matchesStage = payload.stage === input.stage;
    const matchesAttempt = payload.attempt === undefined || payload.attempt === input.attempt;
    if (matchesStage && matchesAttempt && decision === null) decision = payload;
    return {
      accepted: matchesStage && matchesAttempt,
      stage: input.stage,
      decision: payload.decision,
    };
  };

  // Registered before the first await: the API may post a decision the instant the
  // `gate.requested` row is visible in the read model.
  setHandler(submitGateDecisionUpdate, accept);
  setHandler(gateDecisionSignal, (payload: GateDecisionInput) => {
    accept(payload);
  });

  let runId: string | null = null;
  let runStatus: StageWorkflowResult['status'] = 'ok';
  let summary: string | undefined;

  if (input.phase === 'run' || input.phase === 'review') {
    runId = stageRunId(input.workItemId, input.stage, input.attempt, input.reviewerIndex);

    const prompt = [
      input.prompt,
      '',
      `Stage: ${input.stage}`,
      ...(input.reviewerIndex !== undefined
        ? [`Independent reviewer: ${input.reviewerIndex} of the review committee`]
        : []),
      `Work item: ${input.workItemId}`,
      `Definition commit: ${input.definitionCommit}`,
    ].join('\n');

    const runInput: RunInput = {
      runId,
      factory: input.factory,
      factoryRoot: input.factoryRoot,
      definitionCommit: input.definitionCommit,
      definitionDirty: input.definitionDirty,
      harness: input.harness,
      ...(input.model ? { model: input.model } : {}),
      ...(input.agent ? { agent: input.agent } : {}),
      runner: input.runner,
      ...(input.repo ? { repo: input.repo } : {}),
      ...(input.patchRunId ? { patchRunId: input.patchRunId } : {}),
      prompt: { text: prompt },
      kind: 'run',
      title: `${input.stage}: ${input.title}`,
      proxyModels: input.model ? [input.model] : [],
      // Factory stages are unattended; tool permissions are auto-allowed.
      autoAllowPermissions: true,
      ...(input.permissionTimeoutMs ? { permissionTimeoutMs: input.permissionTimeoutMs } : {}),
    };

    const outcome: RunOutcome = await executeChild(RunWorkflow, {
      workflowId: runWorkflowIdFor(runId),
      args: [runInput],
      workflowExecutionTimeout: '4 hours',
      workflowTaskTimeout: '30 seconds',
    });

    runStatus =
      outcome.status === 'ok' ? 'ok' : outcome.status === 'cancelled' ? 'cancelled' : 'failed';
    summary = outcome.summary;

    if (runStatus !== 'ok') {
      return { stage: input.stage, runId, status: runStatus, gate: null, ...(summary ? { summary } : {}) };
    }
  }

  if (input.phase === 'review') {
    const report = await foreman.reviewFindings({
      workItemId: input.workItemId,
      stage: input.stage,
      reviewerIndex: input.reviewerIndex ?? 1,
      runId,
      runStatus,
      ...(summary ? { summary } : {}),
    });
    return {
      stage: input.stage,
      runId,
      status: 'ok',
      gate: null,
      report,
      ...(summary ? { summary } : {}),
    };
  }

  if (input.gate === 'none') {
    return { stage: input.stage, runId, status: runStatus, gate: null, ...(summary ? { summary } : {}) };
  }

  // Agent gate: the stage's own run/verdict satisfies it. Recorded with its evidence.
  if (input.gate === 'agent') {
    const actor = input.agent ?? 'agent';
    // The gate row is created first so the decision has a stable (item, stage, attempt) key
    // and the event log records both `gate.requested` and `gate.decided`.
    await gates.recordGateRequest({
      workItemId: input.workItemId,
      stage: input.stage,
      attempt: input.attempt,
      gate: 'agent',
      workflowId: workflowInfo().workflowId,
    });
    await gates.resolveGateDecision({
      workItemId: input.workItemId,
      stage: input.stage,
      attempt: input.attempt,
      decision: 'approve',
      actor,
      reason: 'agent gate satisfied by the stage verdict',
      automatic: true,
    });
    const outcome: StageGateOutcome = { decision: 'approve', actor, automatic: true };
    return { stage: input.stage, runId, status: runStatus, gate: outcome, ...(summary ? { summary } : {}) };
  }

  // Human gate (and `policy:<name>`, which has no policy engine yet and resolves human).
  const slaMs = input.gateSlaMs > 0 ? input.gateSlaMs : DEFAULT_GATE_SLA_MS;
  const slaAt = new Date(Date.now() + slaMs).toISOString();

  await gates.recordGateRequest({
    workItemId: input.workItemId,
    stage: input.stage,
    attempt: input.attempt,
    gate: input.gate,
    workflowId: workflowInfo().workflowId,
    slaAt,
  });

  const deadline = Date.now() + slaMs;
  while (currentDecision() === null) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await condition(() => currentDecision() !== null, Math.min(remaining, GATE_WAIT_SLICE_MS));
  }

  const decided = currentDecision();
  if (decided === null) {
    // SLA expired: escalate, then apply the configured fallback.
    const automaticDecision = input.autoApproveAllowed ? 'approve' : 'reject';
    const actor = 'system:sla';
    await gates.resolveGateDecision({
      workItemId: input.workItemId,
      stage: input.stage,
      attempt: input.attempt,
      decision: automaticDecision,
      actor,
      reason: `gate SLA of ${slaMs}ms expired`,
      automatic: true,
    });
    await gates.recordWorkItemEvent({
      workItemId: input.workItemId,
      type: 'gate.escalated',
      stage: input.stage,
      actor,
      payload: {
        slaMs,
        automaticDecision,
        autoApproveAllowed: input.autoApproveAllowed,
        attempt: input.attempt,
      },
    });
    const outcome: StageGateOutcome = {
      decision: automaticDecision,
      actor,
      automatic: true,
      reason: 'sla',
    };
    return { stage: input.stage, runId, status: runStatus, gate: outcome, ...(summary ? { summary } : {}) };
  }

  await gates.resolveGateDecision({
    workItemId: input.workItemId,
    stage: input.stage,
    attempt: input.attempt,
    decision: decided.decision,
    actor: decided.actor,
    reason: decided.reason ?? null,
    feedback: decided.feedback ?? null,
    automatic: false,
  });

  const outcome: StageGateOutcome = {
    decision: decided.decision,
    actor: decided.actor,
    automatic: false,
    ...(decided.reason ? { reason: decided.reason } : {}),
    ...(decided.feedback ? { feedback: decided.feedback } : {}),
  };
  return { stage: input.stage, runId, status: runStatus, gate: outcome, ...(summary ? { summary } : {}) };
}
