import {
  condition,
  defineSignal,
  defineUpdate,
  executeChild,
  proxyActivities,
  setHandler,
  workflowInfo,
} from '@temporalio/workflow';
import { parseAgentVerdict } from '@factory/core/gates/verdict';
import type { ReviewPacket } from '@factory/core';
import {
  VALIDATION_EVIDENCE_INSTRUCTION,
  evaluateValidationContract,
  parseValidationEvidence,
} from '@factory/core/validation/types';
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
 * Verdict contract for agent-gated stages (change `add-agent-verdicts`).
 *
 * Appended only when the stage gate is `agent`: the gate no longer approves every run that
 * ends `ok`, it decides from this block. The parser reads the LAST fenced JSON block, so an
 * earlier quoted verdict cannot spoof the gate.
 */
export const AGENT_VERDICT_INSTRUCTION = [
  'Agent gate — finish your final message with a fenced ```json block:',
  '{"verdict":"approve|request_changes|reject","summary":"<why>","findings":["<finding>"]}',
  'Use approve only when the stage output is acceptable, request_changes for fixable gaps,',
  'reject for an unsafe direction. Without a block the gate falls back to explicit',
  '`VERDICT: PASS` / `VERDICT: FAIL` lines.',
].join('\n');

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

/** Prompt budget for the deterministic context pack (task 4.2). */
const MAX_CONTEXT_PACK_PROMPT_CHARS = 6000;

/** Names every budget overage so `request_changes` feedback is actionable. */
export function slopOverageFeedback(packet: ReviewPacket): string {
  const entries: string[] = [];
  const push = (metric: string, actual: number | null, limit: number): void => {
    if (actual !== null && Number.isFinite(actual) && actual > limit) {
      entries.push(`${metric} ${actual} > ${limit}`);
    }
  };
  push('diffLines', packet.slopActual.diffLines, packet.slopBudget.maxDiffLines);
  push('changedFiles', packet.slopActual.changedFiles, packet.slopBudget.maxChangedFiles);
  push('newDependencies', packet.slopActual.newDependencies, packet.slopBudget.maxNewDependencies);
  push(
    'duplicationDeltaPercent',
    packet.slopActual.duplicationDeltaPercent,
    packet.slopBudget.maxDuplicationDeltaPercent,
  );
  push('complexityDelta', packet.slopActual.complexityDelta, packet.slopBudget.maxComplexityDelta);
  return entries.length > 0
    ? `slop budget exceeded: ${entries.join('; ')}`
    : 'slop budget exceeded';
}

/**
 * True when the packet's standards status must block an agent gate (request changes).
 * A missing packet never blocks — the raw diff stays available to the reviewer.
 */
export function standardsBlockGate(packet: ReviewPacket | null): boolean {
  return packet !== null && packet.standards.status === 'exceeded';
}

/**
 * Names every exceeded standards cap so `request_changes` feedback is actionable
 * (change `add-risk-aware-routing-and-standards`). Counts equal to a cap are not overages.
 */
export function standardsOverageFeedback(packet: ReviewPacket): string {
  const entries: string[] = [];
  const standards = packet.standards;
  if (standards.publicApiChanges > standards.maxPublicApiChanges) {
    entries.push(`public API changes ${standards.publicApiChanges} > ${standards.maxPublicApiChanges}`);
  }
  if (standards.schemaChanges > standards.maxSchemaChanges) {
    entries.push(`schema changes ${standards.schemaChanges} > ${standards.maxSchemaChanges}`);
  }
  return entries.length > 0
    ? `standards exceeded: ${entries.join('; ')}`
    : 'standards exceeded';
}

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
  let validationFailed = false;
  let validationMissing: string[] = [];

  /**
   * Deterministic review packet (change `harden-factory-quality`; v2 in
   * `add-anti-slop-budgets-and-proof`): assembled from plan, evidence, patch and run
   * artifacts before a review gate is requested. Best-effort — a packet failure must never
   * fail the stage, and only the `review` stage carries a patch to measure.
   */
  const contextPackRef =
    input.contextPackRef ?? (input.contextPack ? `${input.workItemId}#context-pack` : null);

  const requestReviewPacket = async (): Promise<ReviewPacket | null> => {
    if (input.stage !== 'review') return null;
    try {
      return await gates.recordReviewPacket({
        workItemId: input.workItemId,
        stage: input.stage,
        attempt: input.attempt,
        riskTier: input.riskTier ?? 'low',
        intent: input.title,
        ...(input.planRef ? { planRef: input.planRef } : {}),
        ...(input.patchRunId ? { patchRunId: input.patchRunId } : {}),
        ...(input.architectureImpact ? { architectureImpact: input.architectureImpact } : {}),
        ...(input.openQuestions ? { openQuestions: input.openQuestions } : {}),
        ...(input.slopBudget ? { slopBudget: input.slopBudget } : {}),
        ...(input.quality?.standards ? { standards: input.quality.standards } : {}),
        ...(input.highRiskPaths ? { highRiskPaths: input.highRiskPaths } : {}),
        contextPackRef,
        definitionCommit: input.definitionCommit,
      });
    } catch {
      // Best-effort: the raw diff and events remain available to the reviewer.
      return null;
    }
  };

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
      ...(input.planDepth ? [`Plan depth: ${input.planDepth}`] : []),
      ...(input.expectedPain ? [`Expected pain: ${input.expectedPain}`] : []),
      ...(input.leverage ? [`Leverage: ${input.leverage}`] : []),
      ...(input.contextPack
        ? [
            '',
            'Context pack:',
            input.contextPack.length > MAX_CONTEXT_PACK_PROMPT_CHARS
              ? `${input.contextPack.slice(0, MAX_CONTEXT_PACK_PROMPT_CHARS - 1)}…`
              : input.contextPack,
          ]
        : []),
      ...(input.gate === 'agent' ? ['', AGENT_VERDICT_INSTRUCTION] : []),
      ...(input.stage === 'verify' && input.validationContract
        ? [
            '',
            VALIDATION_EVIDENCE_INSTRUCTION,
            '',
            `Validation contract: ${JSON.stringify(input.validationContract.checks)}`,
          ]
        : []),
    ].join('\n');

    const runInput: RunInput = {
      runId,
      ...(input.missionId ? { missionId: input.missionId } : {}),
      factory: input.factory,
      ...(input.factoryId ? { factoryId: input.factoryId } : {}),
      factoryRoot: input.factoryRoot,
      definitionCommit: input.definitionCommit,
      definitionDirty: input.definitionDirty,
      harness: input.harness,
      ...(input.model ? { model: input.model } : {}),
      ...(input.agent ? { agent: input.agent } : {}),
      runner: input.runner,
      ...(input.repo ? { repo: input.repo } : {}),
      // Remote harnesses need the proxy/artifact-store network; the host's egress policy
      // is the boundary. Local sandboxes keep the default denial.
      ...(input.runner === 'remote' ? { networkPolicy: 'allowed' as const } : {}),
      ...(input.patchRunId ? { patchRunId: input.patchRunId } : {}),
      prompt: { text: prompt },
      kind: 'run',
      title: `${input.stage}: ${input.title}`,
      proxyModels: input.model ? [input.model] : [],
      // Factory stages are unattended; tool permissions are auto-allowed.
      autoAllowPermissions: true,
      ...(input.maxCostUsd !== undefined ? { maxCostUsd: input.maxCostUsd } : {}),
      ...(input.governance ? { governance: input.governance } : {}),
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

  // Verify-stage validation evidence (roadmap item 1): parse the agent's fenced JSON
  // report, evaluate the contract against it and append the evidence event. Enforcement
  // turns a missing required check into `request_changes` on an agent gate; human gates
  // are enforced by the API on approve.
  if (input.phase === 'run' && input.stage === 'verify' && input.validationContract) {
    const evidence = parseValidationEvidence(summary ?? '');
    const projection = evaluateValidationContract(input.validationContract, evidence);
    await gates.recordWorkItemEvent({
      workItemId: input.workItemId,
      type: 'validation.evidence',
      stage: input.stage,
      actor: input.agent ?? 'qa',
      payload: {
        contractId: input.validationContract.workItemId,
        checks: evidence,
        complete: projection.complete,
        missing: projection.missing,
      },
    });
    validationFailed = input.validationContract.enforce && !projection.complete;
    validationMissing = projection.missing;
  }

  if (input.gate === 'none') {
    return { stage: input.stage, runId, status: runStatus, gate: null, ...(summary ? { summary } : {}) };
  }

  // Agent gate: the stage's own verdict satisfies it. Recorded with its evidence.
  if (input.gate === 'agent') {
    const actor = input.agent ?? 'agent';

    // Gate-only children (`ship`, the review committee's final gate) have no stage run to
    // verdict. The review judge already forced a human gate on a non-approve verdict, so an
    // agent gate here keeps the pre-verdict semantics.
    if (input.phase === 'gate') {
      const packet = await requestReviewPacket();
      const overages: string[] = [];
      if (packet?.slopStatus === 'exceeded') {
        const { slopActual: actual, slopBudget: budget } = packet;
        if (actual.changedFiles > budget.maxChangedFiles) {
          overages.push(`${actual.changedFiles} files > ${budget.maxChangedFiles}`);
        }
        if (actual.newDependencies > budget.maxNewDependencies) {
          overages.push(`${actual.newDependencies} new dependencies > ${budget.maxNewDependencies}`);
        }
        if (actual.diffLines > budget.maxDiffLines) {
          overages.push(`${actual.diffLines} diff lines > ${budget.maxDiffLines}`);
        }
        if (
          actual.duplicationDeltaPercent !== null &&
          actual.duplicationDeltaPercent > budget.maxDuplicationDeltaPercent
        ) {
          overages.push(
            `${actual.duplicationDeltaPercent}% duplication > ${budget.maxDuplicationDeltaPercent}%`,
          );
        }
        if (actual.complexityDelta !== null && actual.complexityDelta > budget.maxComplexityDelta) {
          overages.push(`${actual.complexityDelta} complexity > ${budget.maxComplexityDelta}`);
        }
      }
      const slopExceeded = overages.length > 0;
      const standardsExceeded = standardsBlockGate(packet);
      const feedbackParts: string[] = [];
      if (slopExceeded) feedbackParts.push(`slop budget exceeded: ${overages.join('; ')}`);
      if (standardsExceeded && packet) feedbackParts.push(standardsOverageFeedback(packet));
      const blocked = feedbackParts.length > 0;
      const decision: StageGateOutcome['decision'] = blocked ? 'request_changes' : 'approve';
      const reason =
        slopExceeded && standardsExceeded
          ? 'slop budget and standards exceeded'
          : slopExceeded
            ? 'slop budget exceeded'
            : standardsExceeded
              ? 'standards exceeded'
              : 'agent gate satisfied by the gate evidence';
      const feedback = blocked ? feedbackParts.join('; ') : undefined;
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
        decision,
        actor,
        reason,
        ...(feedback ? { feedback } : {}),
        automatic: true,
      });
      const outcome: StageGateOutcome = {
        decision,
        actor,
        automatic: true,
        reason,
        ...(feedback ? { feedback } : {}),
      };
      return { stage: input.stage, runId, status: runStatus, gate: outcome, ...(summary ? { summary } : {}) };
    }

    const verdict = parseAgentVerdict(summary);

    // The packet is recorded before deciding: a measured budget overage is a stop condition
    // (task 1.4). Validation enforcement still wins; a packet failure is ignored.
    const packet = await requestReviewPacket();

    // `request_changes` feeds the existing loop/escalation path in `factory.ts`; a missing
    // verdict is only fatal when the factory opts into `agentVerdict: required`.
    const required = (input.agentVerdict ?? 'advisory') === 'required';
    // Structured blocks carry their own summary; the textual fallback's matched line is only
    // a signal, so the full run summary is the actionable feedback there.
    const verdictFeedback = verdict.source === 'structured' ? (verdict.summary ?? summary) : summary;
    let decision: StageGateOutcome['decision'];
    let reason: string;
    let feedback: string | undefined;

    if (validationFailed) {
      // Validation enforcement wins over the verdict chain: an agent cannot approve a
      // verify stage whose enforced contract still lacks required evidence.
      decision = 'request_changes';
      reason = 'validation incomplete';
      feedback = `validation incomplete: missing ${validationMissing.join(', ')}`;
    } else if (verdict.decision === 'reject') {
      decision = 'reject';
      reason = 'agent verdict: reject';
      feedback = verdictFeedback;
    } else if (verdict.decision === 'request_changes') {
      decision = 'request_changes';
      reason = 'agent verdict: request_changes';
      feedback = verdictFeedback;
    } else if (packet?.slopStatus === 'exceeded') {
      // Budget overage stops the loop even when the agent approved its own work.
      decision = 'request_changes';
      reason = 'slop budget exceeded';
      feedback = slopOverageFeedback(packet);
    } else if (packet !== null && standardsBlockGate(packet)) {
      // Public-API/schema blast radius above the factory caps stops the loop too.
      decision = 'request_changes';
      reason = 'standards exceeded';
      feedback = standardsOverageFeedback(packet);
    } else if (verdict.decision === 'approve') {
      decision = 'approve';
      reason = 'agent verdict: approve';
    } else if (required) {
      decision = 'request_changes';
      reason = 'missing agent verdict';
      feedback = summary;
    } else {
      decision = 'approve';
      reason = 'agent gate satisfied by the stage verdict';
    }

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
      decision,
      actor,
      reason,
      feedback: feedback ?? null,
      verdict,
      automatic: true,
    });
    const outcome: StageGateOutcome = {
      decision,
      actor,
      automatic: true,
      reason,
      ...(feedback ? { feedback } : {}),
      verdict,
    };
    return { stage: input.stage, runId, status: runStatus, gate: outcome, ...(summary ? { summary } : {}) };
  }

  // Human gate (and `policy:<name>`, which has no policy engine yet and resolves human).
  const slaMs = input.gateSlaMs > 0 ? input.gateSlaMs : DEFAULT_GATE_SLA_MS;
  const slaAt = new Date(Date.now() + slaMs).toISOString();

  await requestReviewPacket();
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
