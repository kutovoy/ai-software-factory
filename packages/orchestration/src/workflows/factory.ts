import {
  CancellationScope,
  continueAsNew,
  defineSignal,
  executeChild,
  isCancellation,
  proxyActivities,
  setHandler,
  startChild,
} from '@temporalio/workflow';
import type * as activities from '../activities';
import type {
  AutonomyPausedSignal,
  CancelWorkItemSignal,
  FactoryWorkflowInput,
  FactoryWorkflowOutcome,
  FactoryWorkflowResume,
  LoopStageName,
  ReviewerReport,
  StageNodeSummary,
  StageWorkflowInput,
  StageWorkflowResult,
} from '../types';
import { stageWorkflowId } from '../types';
import { StageWorkflow } from './stage';

/**
 * FactoryWorkflow — one durable workflow per work item (design decision 1).
 *
 * Shape: entry judgement → for each stage in the compiled graph: autonomy check → foreman
 * dispatch (`spawnableBy`) → child `StageWorkflow` (run + gate) → transition. `review`
 * fans out to independent reviewer children and a judge produces an advisory verdict; the
 * review gate is then resolved by a gate-only child. `implement` opens a pull request;
 * `verify` reads the forge checks; `ship` merges only when the merge policy allows it.
 *
 * Everything a human waits on is a workflow-level durable wait (ADR-013) inside the child
 * stage workflow; the parent holds no activity slot while waiting either.
 *
 * Bounded history: after `maxStagesPerRun` completed stages the workflow calls
 * `continueAsNew` with its resume state (stage index, attempts, loop count, PR, verdict).
 *
 * Kill switch: the `autonomyPaused` Signal (and the `autonomy_state` read model, checked
 * before every dispatch) stops new stage dispatch, forces every gate to `human`, and
 * cancels the in-flight stage child — the workflow ends `blocked`, the item lands in the
 * inbox with a `autonomy.paused` event naming the actor.
 *
 * Review verdicts are advisory only: the loop never posts an approval and never merges on
 * a verdict. Merging is decided by the merge policy + the ship gate.
 */

const foreman = proxyActivities<typeof activities>({
  startToCloseTimeout: '10 minutes',
  retry: {
    initialInterval: '1 second',
    backoffCoefficient: 2,
    maximumInterval: '30 seconds',
    maximumAttempts: 5,
  },
});

const workItems = proxyActivities<typeof activities>({
  startToCloseTimeout: '1 minute',
  retry: {
    initialInterval: '500ms',
    backoffCoefficient: 2,
    maximumInterval: '10 seconds',
    maximumAttempts: 10,
  },
});

const forge = proxyActivities<typeof activities>({
  startToCloseTimeout: '5 minutes',
  retry: {
    initialInterval: '1 second',
    backoffCoefficient: 2,
    maximumInterval: '30 seconds',
    maximumAttempts: 5,
  },
});

/** Kill switch: pause autonomy for this work item. */
export const autonomyPausedSignal = defineSignal<[AutonomyPausedSignal]>('autonomyPaused');

/** Graceful cancellation of a work item (the API records the reason in the read model). */
export const cancelWorkItemSignal = defineSignal<[CancelWorkItemSignal]>('cancelWorkItem');

const UNATTENDED_MERGE_POLICIES = new Set(['auto_on_green', 'auto_after_n_approvals']);

export async function FactoryWorkflow(
  input: FactoryWorkflowInput,
): Promise<FactoryWorkflowOutcome> {
  const resume: FactoryWorkflowResume = input.resume ?? {
    stageIndex: 0,
    loopCount: 0,
    stagesCompleted: 0,
    attempts: {},
    currentStage: (input.stageGraph.order[0] as LoopStageName) ?? 'triage',
  };

  let stageIndex = resume.stageIndex;
  let loopCount = resume.loopCount;
  let stagesCompleted = resume.stagesCompleted;
  const attempts: Record<string, number> = { ...resume.attempts };
  let currentStage = resume.currentStage as LoopStageName;
  let prUrl = resume.prUrl;
  let prNumber = resume.prNumber;
  let reviewVerdict = resume.reviewVerdict;
  let patchRunId = resume.patchRunId;

  let paused = input.autonomy.paused;
  let pauseActor: string | null = null;
  let pauseReason: string | null = null;
  let cancelled = false;
  let cancelReason: string | undefined;
  let cancelActor: string | undefined;

  /** The scope wrapping the current stage child, so the kill switch can stop it. */
  let stageScope: CancellationScope | null = null;

  setHandler(autonomyPausedSignal, (payload: AutonomyPausedSignal) => {
    paused = true;
    pauseActor = payload.actor;
    pauseReason = payload.reason;
    stageScope?.cancel();
  });

  setHandler(cancelWorkItemSignal, (payload?: CancelWorkItemSignal) => {
    cancelled = true;
    cancelActor = payload?.actor;
    cancelReason = payload?.reason ?? 'cancelled';
    stageScope?.cancel();
  });

  const order = input.stageGraph.order;

  const nodeFor = (stage: string): StageNodeSummary | null =>
    input.stageGraph.nodes.find((node) => node.name === stage) ?? null;

  const finish = (
    status: FactoryWorkflowOutcome['status'],
    stage: string,
    reason?: string,
    merged?: boolean,
  ): FactoryWorkflowOutcome => ({
    workItemId: input.workItemId,
    status,
    stage,
    stagesCompleted,
    loopCount,
    ...(prUrl ? { prUrl } : {}),
    ...(merged !== undefined ? { merged } : {}),
    ...(reviewVerdict ? { reviewVerdict } : {}),
    ...(reason ? { reason } : {}),
  });

  const blockForPause = async (stage: string, reason: string): Promise<FactoryWorkflowOutcome> => {
    await workItems.recordWorkItemEvent({
      workItemId: input.workItemId,
      type: 'autonomy.paused',
      stage,
      actor: pauseActor ?? 'system',
      payload: { reason },
    });
    await workItems.setWorkItemStatusActivity({
      workItemId: input.workItemId,
      status: 'blocked',
      actor: pauseActor ?? 'system',
      reason,
    });
    return finish('blocked', stage, reason);
  };

  /**
   * Cooperative cancellation (task 1.3): the read model is written once, the in-flight
   * stage child is cancelled by the Signal, and the item ends `cancelled` with exactly one
   * `work_item.cancelled` event.
   */
  const finishCancelled = async (
    stage: string,
    actor: string | null,
    reason: string,
  ): Promise<FactoryWorkflowOutcome> => {
    await workItems.cancelWorkItem({
      workItemId: input.workItemId,
      stage,
      actor: actor ?? 'human',
      reason,
    });
    return finish('cancelled', stage, reason);
  };

  /* ------------------------------------------------ entry judgement call */

  if (!input.resume) {
    try {
      const judgement = await foreman.judgementCall({
        workItemId: input.workItemId,
        title: input.title,
        sourceRef: input.sourceRef,
        prompt: input.prompt,
      });

      if (judgement.classification === 'reject') {
        await workItems.setWorkItemStatusActivity({
          workItemId: input.workItemId,
          status: 'cancelled',
          actor: 'foreman',
          reason: judgement.reason,
        });
        return finish('cancelled', currentStage, judgement.reason);
      }

      if (judgement.classification === 'wait') {
        await workItems.setWorkItemStatusActivity({
          workItemId: input.workItemId,
          status: 'blocked',
          actor: 'foreman',
          reason: judgement.reason,
        });
        return finish('blocked', currentStage, judgement.reason);
      }
    } catch (error) {
      if (isCancellation(error)) throw error;
      // `judgement_invalid` after retries: escalate to a human instead of guessing.
      await workItems.setWorkItemStatusActivity({
        workItemId: input.workItemId,
        status: 'escalated',
        actor: 'foreman',
        reason: 'judgement call could not be resolved; a human must classify the item',
      });
      return finish('escalated', currentStage, 'judgement call escalated');
    }
  }

  /* ------------------------------------------------------------- the loop */

  while (stageIndex < order.length) {
    if (cancelled) {
      return await finishCancelled(
        currentStage,
        cancelActor ?? 'human',
        cancelReason ?? 'cancelled',
      );
    }

    // A recorded request whose Signal never arrived still cancels the item.
    const cancelState = await workItems.readWorkItemCancel({ workItemId: input.workItemId });
    if (cancelState.requested) {
      return await finishCancelled(
        currentStage,
        cancelState.actor,
        cancelState.reason ?? 'cancelled',
      );
    }

    const stage = order[stageIndex] as LoopStageName;
    const node = nodeFor(stage);
    if (!node) {
      return finish('escalated', currentStage, `stage "${stage}" is missing from the compiled graph`);
    }

    // Kill switch: read the read model before every dispatch so an API pause takes effect
    // even when the Signal was lost. New stage dispatch stops; the item goes to the inbox.
    const autonomy = await workItems.readAutonomyState({ factory: input.factory });
    if (autonomy.paused) {
      paused = true;
      pauseActor = autonomy.actor ?? pauseActor;
      pauseReason = autonomy.reason ?? pauseReason;
    }
    if (paused) {
      return await blockForPause(currentStage, pauseReason ?? 'autonomy paused');
    }

    const attempt = (attempts[stage] ?? 0) + 1;
    attempts[stage] = attempt;

    await foreman.dispatchStage({
      workItemId: input.workItemId,
      factory: input.factory,
      factoryRoot: input.factoryRoot,
      stage,
      byAgent: 'foreman',
      targetAgent: node.agent,
      attempt,
    });

    if (stage !== currentStage) {
      await workItems.recordStageTransition({
        workItemId: input.workItemId,
        from: currentStage,
        to: stage,
        by: 'foreman',
        reason: 'foreman dispatch',
      });
      currentStage = stage;
    }

    const autoApproveAllowed =
      input.autonomy.enabled &&
      input.autonomy.benchmarkGateSatisfied &&
      UNATTENDED_MERGE_POLICIES.has(input.mergePolicy);

    const stageHarness = input.harnessOverride ?? node.harness ?? input.defaultHarness;
    // The fake harness always runs on the ephemeral fake runner, never a sandbox.
    const stageRunner = stageHarness === 'fake' ? 'fake' : (node.runner ?? input.defaultRunner);

    const common: Omit<StageWorkflowInput, 'phase' | 'gate'> = {
      workItemId: input.workItemId,
      factory: input.factory,
      ...(input.factoryId ? { factoryId: input.factoryId } : {}),
      factoryRoot: input.factoryRoot,
      definitionCommit: input.definitionCommit,
      definitionDirty: input.definitionDirty,
      stage,
      attempt,
      agent: node.agent,
      harness: stageHarness,
      ...(node.model ?? input.defaultModel
        ? { model: (node.model ?? input.defaultModel) as string }
        : {}),
      runner: stageRunner,
      tools: node.tools,
      gateSlaMs: input.gateSlaMs,
      agentVerdict: input.agentVerdict ?? 'advisory',
      autoApproveAllowed,
      title: input.title,
      prompt: input.prompt,
      ...(input.repo ? { repo: input.repo } : {}),
      // Implement always starts from a clean checkout: its patch is the PR's content, so it
      // must be a diff against the definition commit, not against a previous attempt.
      ...(stage !== 'implement' && patchRunId ? { patchRunId } : {}),
      ...(input.permissionTimeoutMs ? { permissionTimeoutMs: input.permissionTimeoutMs } : {}),
      ...(input.validationContract ? { validationContract: input.validationContract } : {}),
      ...(input.governance ? { governance: input.governance } : {}),
      ...(input.budget?.maxCostUsdPerStage !== undefined
        ? { maxCostUsd: input.budget.maxCostUsdPerStage }
        : input.budget?.maxCostUsdPerRun !== undefined
          ? { maxCostUsd: input.budget.maxCostUsdPerRun }
          : {}),
    };

    stageScope = new CancellationScope();
    let result: StageWorkflowResult;

    try {
      result = await stageScope.run(async (): Promise<StageWorkflowResult> => {
        if (stage === 'review' && node.reviewers >= 2) {
          const handles = await Promise.all(
            Array.from({ length: node.reviewers }, (_, index) => {
              const reviewerIndex = index + 1;
              const reviewerInput: StageWorkflowInput = {
                ...common,
                phase: 'review',
                gate: 'none',
                reviewerIndex,
              };
              return startChild(StageWorkflow, {
                workflowId: stageWorkflowId(input.workItemId, stage, attempt, `r${reviewerIndex}`),
                args: [reviewerInput],
                workflowExecutionTimeout: '4 hours',
                workflowTaskTimeout: '30 seconds',
              });
            }),
          );

          const reviewerResults = await Promise.all(handles.map((handle) => handle.result()));
          const failedReviewer = reviewerResults.find((review) => review.status !== 'ok');
          if (failedReviewer) {
            return {
              stage,
              runId: failedReviewer.runId,
              status: 'failed',
              gate: null,
              ...(failedReviewer.summary ? { summary: failedReviewer.summary } : {}),
            };
          }

          const reports = reviewerResults
            .map((review) => review.report)
            .filter((report): report is ReviewerReport => report !== undefined);

          const verdict = await foreman.judgeReviews({
            workItemId: input.workItemId,
            stage,
            reports,
            minReviewers: node.reviewers,
          });
          reviewVerdict = verdict;

          // Disagreement / reject / incomplete reports force a human review gate.
          const forceHuman = verdict.verdict !== 'approve';
          const gateInput: StageWorkflowInput = {
            ...common,
            phase: 'gate',
            gate: forceHuman ? 'human' : node.gate,
            autoApproveAllowed: forceHuman ? false : autoApproveAllowed,
            verdict,
            findings: verdict.findings,
          };

          const gateResult = await executeChild(StageWorkflow, {
            workflowId: stageWorkflowId(input.workItemId, stage, attempt, 'gate'),
            args: [gateInput],
            workflowExecutionTimeout: '7 days',
            workflowTaskTimeout: '30 seconds',
          });

          return {
            stage,
            runId: null,
            status: 'ok',
            gate: gateResult.gate,
            summary: verdict.verdict,
          };
        }

        const stageInput: StageWorkflowInput = {
          ...common,
          // `ship` is a forge/merge stage, not an agent run: it only resolves the deploy
          // gate and the parent then merges (or hands the PR to the merge queue).
          phase: stage === 'ship' ? 'gate' : 'run',
          gate: node.gate,
        };

        return await executeChild(StageWorkflow, {
          workflowId: stageWorkflowId(input.workItemId, stage, attempt),
          args: [stageInput],
          workflowExecutionTimeout: '7 days',
          workflowTaskTimeout: '30 seconds',
        });
      });
    } catch (error) {
      if (isCancellation(error)) {
        if (cancelled) {
          return await finishCancelled(
            currentStage,
            cancelActor ?? 'human',
            cancelReason ?? 'cancelled',
          );
        }
        return await blockForPause(currentStage, pauseReason ?? 'autonomy paused');
      }
      throw error;
    } finally {
      stageScope = null;
    }

    if (result.status === 'failed') {
      await workItems.recordWorkItemEvent({
        workItemId: input.workItemId,
        type: 'gate.escalated',
        stage,
        actor: 'foreman',
        payload: { reason: 'stage run failed', summary: result.summary ?? null },
      });
      await workItems.setWorkItemStatusActivity({
        workItemId: input.workItemId,
        status: 'escalated',
        actor: 'foreman',
        reason: `stage "${stage}" run failed`,
      });
      return finish('escalated', stage, `stage "${stage}" run failed`);
    }

    if (result.status === 'cancelled') {
      // The stage child can observe cancellation before the parent consumes the Signal.
      // Preserve the operator's recorded actor/reason instead of replacing it with a
      // generic "stage run cancelled" message.
      return await finishCancelled(
        stage,
        cancelActor ?? 'foreman',
        cancelReason ?? 'stage run cancelled',
      );
    }

    // implement: branch + commit + PR referencing the work item (forge abstraction).
    if (stage === 'implement' && result.runId) {
      // Downstream stages (review, verify) run on this patch: they checkout the definition
      // commit and apply it, so they inspect the change instead of a clean tree.
      patchRunId = result.runId;
      try {
        const opened = await forge.forgeOpenPullRequest({
          workItemId: input.workItemId,
          factory: input.factory,
          factoryRoot: input.factoryRoot,
          title: input.title,
          body:
            `Work item ${input.workItemId}\n\n` +
            `Implements the approved scope. Definition commit: ${input.definitionCommit}.`,
          runId: result.runId,
        });
        prUrl = opened.prUrl;
        prNumber = opened.prNumber;
        await workItems.attachWorkItemPullRequest({
          workItemId: input.workItemId,
          prUrl: opened.prUrl,
          prNumber: opened.prNumber,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await workItems.recordWorkItemEvent({
          workItemId: input.workItemId,
          type: 'gate.escalated',
          stage,
          actor: 'forge',
          payload: { reason: 'pull request could not be opened', error: message },
        });
        await workItems.setWorkItemStatusActivity({
          workItemId: input.workItemId,
          status: 'escalated',
          actor: 'forge',
          reason: `pull request could not be opened: ${message}`,
        });
        return finish('escalated', stage, `pull request could not be opened: ${message}`);
      }
    }

    // verify: deterministic checks from the forge (red checks stop the loop).
    if (stage === 'verify' && prNumber) {
      const checks = await forge.forgeGetChecks({
        factory: input.factory,
        factoryRoot: input.factoryRoot,
        pullRequestNumber: prNumber,
      });
      await workItems.recordWorkItemEvent({
        workItemId: input.workItemId,
        type: 'checks.recorded',
        stage,
        actor: 'forge',
        payload: { green: checks.green, checks: checks.checks },
      });
      if (!checks.green) {
        await workItems.setWorkItemStatusActivity({
          workItemId: input.workItemId,
          status: 'escalated',
          actor: 'forge',
          reason: 'checks are not green',
        });
        return finish('escalated', stage, 'checks are not green');
      }
    }

    const gateDecision = result.gate?.decision ?? 'approve';
    const feedback = result.gate?.feedback ?? result.gate?.reason;

    if (gateDecision === 'reject') {
      await workItems.setWorkItemStatusActivity({
        workItemId: input.workItemId,
        status: 'cancelled',
        actor: result.gate?.actor ?? 'gate',
        reason: result.gate?.reason ?? 'gate rejected',
      });
      return finish('cancelled', stage, result.gate?.reason ?? 'gate rejected');
    }

    if (gateDecision === 'request_changes') {
      loopCount += 1;
      await workItems.recordWorkItemEvent({
        workItemId: input.workItemId,
        type: 'loop.requested_changes',
        stage,
        actor: result.gate?.actor ?? 'gate',
        payload: { feedback: feedback ?? null, loopCount },
      });

      if (loopCount > input.loopLimit) {
        // Still move back one stage (the feedback is attached) so the read model shows the
        // loop count and where the item landed; then escalate to a human.
        const previous = stageIndex > 0 ? (order[stageIndex - 1] as LoopStageName) : null;
        if (previous) {
          await workItems.recordStageTransition({
            workItemId: input.workItemId,
            from: stage,
            to: previous,
            by: 'foreman',
            actor: result.gate?.actor ?? null,
            reason: `request_changes: ${feedback ?? 'no feedback'}`,
            loopCountDelta: 1,
          });
          currentStage = previous;
        }
        await workItems.recordWorkItemEvent({
          workItemId: input.workItemId,
          type: 'loop.escalated',
          stage,
          payload: { loopCount, limit: input.loopLimit },
        });
        await workItems.setWorkItemStatusActivity({
          workItemId: input.workItemId,
          status: 'escalated',
          actor: 'foreman',
          reason: 'request_changes loop limit exceeded',
        });
        return finish('escalated', stage, 'request_changes loop limit exceeded');
      }

      const previous = stageIndex > 0 ? (order[stageIndex - 1] as LoopStageName) : null;
      if (!previous) {
        await workItems.setWorkItemStatusActivity({
          workItemId: input.workItemId,
          status: 'escalated',
          actor: 'foreman',
          reason: 'request_changes at the first stage',
        });
        return finish('escalated', stage, 'request_changes at the first stage');
      }

      // Back one stage with the feedback attached; the loop counter is already incremented.
      await workItems.recordStageTransition({
        workItemId: input.workItemId,
        from: stage,
        to: previous,
        by: 'foreman',
        actor: result.gate?.actor ?? null,
        reason: `request_changes: ${feedback ?? 'no feedback'}`,
        loopCountDelta: 1,
      });
      currentStage = previous;
      stageIndex -= 1;
      continue;
    }

    // approve
    stagesCompleted += 1;
    stageIndex += 1;
    currentStage = stage;

    if (stage === 'ship') {
      if (!prNumber) {
        await workItems.setWorkItemStatusActivity({
          workItemId: input.workItemId,
          status: 'done',
          actor: 'foreman',
          reason: 'all stages completed without a pull request',
        });
        return finish('done', stage);
      }

      if (input.mergePolicy === 'disabled') {
        await workItems.setWorkItemStatusActivity({
          workItemId: input.workItemId,
          status: 'done',
          actor: 'foreman',
          reason: 'merge policy is disabled; the pull request stays open',
        });
        return finish('done', stage, 'merge policy disabled', false);
      }

      if (input.mergePolicy === 'human' && result.gate?.automatic === true) {
        await workItems.setWorkItemStatusActivity({
          workItemId: input.workItemId,
          status: 'escalated',
          actor: 'foreman',
          reason: 'merge policy requires a human merge decision',
        });
        return finish('escalated', stage, 'merge policy requires a human merge decision');
      }

      // A review verdict is advisory: a human decision at the ship gate supersedes it.
      // Nothing merges on the verdict alone, and nothing here posts an approval.

      // ADR-022: the merge queue owns merges. The stage opens a PR and enqueues it; the
      // queue batches, gates the merged stack and merges (or bisects/reverts). Nothing in
      // the loop writes the default branch.
      if (input.mergeQueue) {
        let enqueued: Awaited<ReturnType<typeof forge.enqueueMergeRequestActivity>>;
        try {
          enqueued = await forge.enqueueMergeRequestActivity({
            factory: input.factory,
            factoryRoot: input.factoryRoot,
            pullRequestNumber: prNumber,
            workItemId: input.workItemId,
            head: `factory/${input.workItemId}`,
          });
        } catch (error) {
          if (isCancellation(error)) throw error;
          await workItems.recordWorkItemEvent({
            workItemId: input.workItemId,
            type: 'merge.enqueue_failed',
            stage,
            actor: 'foreman',
            payload: { prNumber, reason: error instanceof Error ? error.message : String(error) },
          });
          await workItems.setWorkItemStatusActivity({
            workItemId: input.workItemId,
            status: 'escalated',
            actor: 'foreman',
            reason: 'the pull request could not be enqueued for merge',
          });
          return finish('escalated', stage, 'merge queue enqueue failed');
        }
        await workItems.recordWorkItemEvent({
          workItemId: input.workItemId,
          type: 'merge.queued',
          stage,
          actor: 'foreman',
          payload: {
            prNumber,
            queueItemId: enqueued.itemId,
            mergeQueueWorkflowId: enqueued.workflowId,
          },
        });
        await workItems.setWorkItemStatusActivity({
          workItemId: input.workItemId,
          status: 'done',
          actor: 'foreman',
          reason: 'pull request queued for merge',
        });
        return { ...finish('done', stage, 'pull request queued for merge', false), queued: true };
      }

      const merged = await forge.forgeMergePullRequest({
        factory: input.factory,
        factoryRoot: input.factoryRoot,
        pullRequestNumber: prNumber,
      });
      await workItems.setWorkItemStatusActivity({
        workItemId: input.workItemId,
        status: 'done',
        actor: 'foreman',
        reason: merged.merged ? 'shipped and merged' : 'shipped; merge did not happen',
      });
      return finish('done', stage, merged.merged ? undefined : 'merge did not happen', merged.merged);
    }

    // Bounded history: hand the resume state to a fresh workflow run.
    if (stageIndex < order.length && stagesCompleted >= input.maxStagesPerRun) {
      await continueAsNew<typeof FactoryWorkflow>({
        ...input,
        resume: {
          stageIndex,
          loopCount,
          stagesCompleted,
          attempts,
          currentStage,
          ...(prUrl ? { prUrl } : {}),
          ...(prNumber ? { prNumber } : {}),
          ...(reviewVerdict ? { reviewVerdict } : {}),
          ...(patchRunId ? { patchRunId } : {}),
        },
      });
    }
  }

  await workItems.setWorkItemStatusActivity({
    workItemId: input.workItemId,
    status: 'done',
    actor: 'foreman',
    reason: 'all stages completed',
  });
  return finish('done', currentStage);
}
