import {
  CancellationScope,
  condition,
  continueAsNew,
  defineSignal,
  defineUpdate,
  executeChild,
  isCancellation,
  proxyActivities,
  setHandler,
  workflowInfo,
} from '@temporalio/workflow';
import type * as activities from '../activities';
import {
  missionFeatureOrder,
  missionMilestoneProgress,
  nextRunnableMissionFeature,
} from '../mission-plan';
import type {
  FactoryWorkflowOutcome,
  MissionCancelSignal,
  MissionFeatureStatus,
  MissionMilestonePlanData,
  MissionOutcomeStatus,
  MissionPauseSignal,
  MissionPlanData,
  MissionPlanDecisionAck,
  MissionPlanDecisionInput,
  MissionResumeSignal,
  MissionStatus,
  MissionValidationKind,
  MissionWorkflowInput,
  MissionWorkflowOutcome,
} from '../types';
import { runWorkflowIdFor, workItemWorkflowId } from '../types';
import { FactoryWorkflow } from './factory';
import { RunWorkflow } from './run';

/**
 * MissionWorkflow — the durable orchestrator above work items (design decision 1).
 *
 * Shape: plan (or take the approved plan) → plan gate → for each milestone: run features
 * sequentially as child `FactoryWorkflow`s → validate the milestone with fresh scrutiny +
 * user-testing child runs → create fix features from findings and re-validate, up to a
 * cap → `continueAsNew` at the milestone boundary.
 *
 * Workflow-safe by construction: this file imports only types, pure plan helpers and the
 * Temporal workflow APIs. Every DB read/write, model call and run creation is an activity.
 *
 * Pause/resume/cancel are Signals; pause cancels the in-flight child and resumes with a
 * fresh work item (a cancelled Temporal workflow id cannot be reused). Cancellation is
 * also read from the mission row before every dispatch, so a lost Signal cannot resurrect
 * a cancelled mission. `continueAsNew` never runs while a child is in flight and carries
 * only ids/indices (design decision 7).
 */

const mission = proxyActivities<typeof activities>({
  startToCloseTimeout: '5 minutes',
  retry: {
    initialInterval: '1 second',
    backoffCoefficient: 2,
    maximumInterval: '30 seconds',
    maximumAttempts: 5,
  },
});

const planner = proxyActivities<typeof activities>({
  startToCloseTimeout: '15 minutes',
  retry: {
    initialInterval: '2 seconds',
    backoffCoefficient: 2,
    maximumInterval: '1 minute',
    maximumAttempts: 3,
  },
});

/** Preferred plan-decision channel: a Temporal Update with a synchronous acknowledgement. */
export const submitMissionPlanDecisionUpdate = defineUpdate<
  MissionPlanDecisionAck,
  [MissionPlanDecisionInput]
>('submitMissionPlanDecision');

/** Fallback plan-decision channel for clients that cannot use Updates. */
export const missionPlanDecisionSignal = defineSignal<[MissionPlanDecisionInput]>(
  'missionPlanDecision',
);

export const missionPauseSignal = defineSignal<[MissionPauseSignal]>('missionPause');
export const missionResumeSignal = defineSignal<[MissionResumeSignal]>('missionResume');
export const missionCancelSignal = defineSignal<[MissionCancelSignal]>('missionCancel');

/** Validation rounds before a milestone blocks (design decision 6). */
const MAX_VALIDATION_ROUNDS = 3;
/** Plan attempts after `request_changes` before the mission blocks. */
const MAX_PLAN_ATTEMPTS = 3;

export async function MissionWorkflow(
  input: MissionWorkflowInput,
): Promise<MissionWorkflowOutcome> {
  let plan: MissionPlanData | null = input.plan ?? null;
  let planVersion = input.planVersion ?? 0;

  let planDecision: MissionPlanDecisionInput | null = null;
  let paused = false;
  let pauseActor: string | null = null;
  let pauseReason: string | null = null;
  let pauseCount = 0;
  let cancelled = false;
  let cancelActor: string | null = null;
  let cancelReason: string | null = null;

  /** The scope wrapping the in-flight child, so pause/cancel can stop it. */
  let childScope: CancellationScope | null = null;

  /** Last budget snapshot, included in checkpoints (spec: mission checkpoints). */
  let lastBudget: {
    exceeded: boolean;
    reason: string | null;
    usage: { costUsd: number; runs: number; startedAt: string | null };
  } | null = null;

  const acceptPlanDecision = (payload: MissionPlanDecisionInput): MissionPlanDecisionAck => {
    const matchesAttempt = payload.attempt === undefined || payload.attempt === planVersion;
    const applied = matchesAttempt && planDecision === null;
    if (applied) planDecision = payload;
    return {
      accepted: applied,
      decision: payload.decision,
    };
  };

  // Registered before the first await: the API may post a decision the instant the plan
  // gate row is visible in the read model (ADR-013 pattern).
  setHandler(submitMissionPlanDecisionUpdate, acceptPlanDecision);
  setHandler(missionPlanDecisionSignal, (payload: MissionPlanDecisionInput) => {
    acceptPlanDecision(payload);
  });
  setHandler(missionPauseSignal, (payload: MissionPauseSignal) => {
    paused = true;
    pauseActor = payload.actor;
    pauseReason = payload.reason ?? null;
    childScope?.cancel();
  });
  setHandler(missionResumeSignal, (payload: MissionResumeSignal) => {
    paused = false;
    pauseActor = payload.actor;
    pauseReason = payload.reason ?? null;
  });
  setHandler(missionCancelSignal, (payload: MissionCancelSignal) => {
    cancelled = true;
    cancelActor = payload.actor;
    cancelReason = payload.reason;
    childScope?.cancel();
  });

  const finish = (
    status: MissionOutcomeStatus,
    reason?: string,
    milestoneId: string | null = null,
    featureId: string | null = null,
  ): MissionWorkflowOutcome => ({
    missionId: input.missionId,
    status,
    milestoneId,
    featureId,
    ...(reason ? { reason } : {}),
  });

  const cancelMission = async (
    actor: string | null,
    reason: string,
  ): Promise<MissionWorkflowOutcome> => {
    await mission.setMissionStatusActivity({
      missionId: input.missionId,
      status: 'cancelled',
      error: reason,
    });
    // Exactly one cancellation event; a retried activity dedupes.
    await mission.appendMissionEventActivity({
      missionId: input.missionId,
      type: 'mission.cancelled',
      actor: actor ?? 'human',
      payload: { reason },
      dedupeKey: 'cancelled',
    });
    return finish('cancelled', reason);
  };

  const blockMission = async (
    reason: string,
    milestoneId: string | null,
    featureId: string | null,
  ): Promise<MissionWorkflowOutcome> => {
    await mission.setMissionStatusActivity({
      missionId: input.missionId,
      status: 'blocked',
      error: reason,
      ...(milestoneId ? { currentMilestoneId: milestoneId } : {}),
      ...(featureId ? { currentFeatureId: featureId } : {}),
    });
    await mission.appendMissionEventActivity({
      missionId: input.missionId,
      type: 'mission.blocked',
      milestoneId,
      featureId,
      actor: 'orchestrator',
      payload: { reason },
      dedupeKey: `blocked:${milestoneId ?? 'mission'}:${featureId ?? '-'}`,
    });
    return finish('blocked', reason, milestoneId, featureId);
  };

  const budgetBlock = async (
    reason: string,
    milestoneId: string | null,
    featureId: string | null,
  ): Promise<MissionWorkflowOutcome> => {
    await mission.appendMissionEventActivity({
      missionId: input.missionId,
      type: 'mission.budget_exhausted',
      milestoneId,
      featureId,
      actor: 'orchestrator',
      payload: { reason },
      dedupeKey: `budget:${milestoneId ?? 'mission'}:${featureId ?? '-'}`,
    });
    return await blockMission(reason, milestoneId, featureId);
  };

  const pauseMission = async (resumeStatus: MissionStatus = 'running'): Promise<void> => {
    pauseCount += 1;
    await mission.setMissionStatusActivity({
      missionId: input.missionId,
      status: 'paused',
    });
    await mission.appendMissionEventActivity({
      missionId: input.missionId,
      type: 'mission.paused',
      actor: pauseActor ?? 'human',
      payload: { reason: pauseReason ?? 'paused' },
      dedupeKey: `paused:${pauseCount}`,
    });

    // Wait for the resume Signal, but also poll the read model once a minute so a lost
    // Signal cannot park a paused mission forever (ADR-013 pattern).
    while (paused && !cancelled) {
      await condition(() => !paused || cancelled, 60_000);
      if (!paused || cancelled) break;
      const state = await mission.loadMissionStateActivity({ missionId: input.missionId });
      if (state.cancelRequested || state.mission.status === 'cancelled') {
        cancelled = true;
        cancelActor = state.cancelActor ?? 'read-model';
        cancelReason = state.cancelReason ?? 'cancelled';
        break;
      }
      if (
        state.mission.status === 'running' ||
        state.mission.status === resumeStatus
      ) {
        paused = false;
        break;
      }
    }
    if (cancelled) return;

    await mission.setMissionStatusActivity({
      missionId: input.missionId,
      status: resumeStatus,
    });
    await mission.appendMissionEventActivity({
      missionId: input.missionId,
      type: 'mission.resumed',
      actor: pauseActor ?? 'human',
      payload: { reason: pauseReason ?? 'resumed' },
      dedupeKey: `resumed:${pauseCount}`,
    });
    pauseActor = null;
    pauseReason = null;
  };

  /* ------------------------------------------------------------- plan phase */

  if (plan) {
    // A plan supplied by the API is already approved (the API owns that decision).
    try {
      missionFeatureOrder(plan);
    } catch (error) {
      return await blockMission(
        `mission plan is invalid: ${error instanceof Error ? error.message : String(error)}`,
        null,
        null,
      );
    }
    planVersion = input.planVersion ?? 1;
  } else {
    await mission.setMissionStatusActivity({
      missionId: input.missionId,
      status: 'planning',
    });
    await mission.appendMissionEventActivity({
      missionId: input.missionId,
      type: 'mission.planning.started',
      actor: 'orchestrator',
      payload: { goal: input.goal },
    });

    let feedback: string | undefined;
    let planAttempt = 0;

    while (plan === null) {
      if (cancelled) return await cancelMission(cancelActor, cancelReason ?? 'cancelled');
      if (paused) {
        await pauseMission('planning');
        if (cancelled) return await cancelMission(cancelActor, cancelReason ?? 'cancelled');
        continue;
      }

      planAttempt += 1;
      const proposed = await planner.planMissionActivity({
        missionId: input.missionId,
        factory: input.factory,
        definitionCommit: input.definitionCommit,
        title: input.title,
        goal: input.goal,
        ...(feedback ? { feedback } : {}),
      });
      plan = proposed;
      planVersion = planAttempt;
      // Clear before the gate row exists so a decision posted immediately after the
      // row becomes visible cannot be wiped by the wait setup.
      planDecision = null;

      await mission.persistMissionPlanActivity({
        missionId: input.missionId,
        plan,
        planVersion,
      });
      await mission.createMissionPlanGateActivity({
        missionId: input.missionId,
        planVersion,
        workflowId: workflowInfo().workflowId,
      });
      await mission.setMissionStatusActivity({
        missionId: input.missionId,
        status: 'awaiting_plan_approval',
      });
      await mission.appendMissionEventActivity({
        missionId: input.missionId,
        type: 'mission.plan.proposed',
        actor: 'orchestrator',
        payload: {
          planVersion,
          attempt: planAttempt,
          milestones: plan.milestones.length,
          features: plan.milestones.reduce(
            (total, milestone) => total + milestone.features.length,
            0,
          ),
        },
        dedupeKey: `plan.proposed:${planVersion}`,
      });

      while (true) {
        await condition(() => planDecision !== null || paused || cancelled);
        if (cancelled) return await cancelMission(cancelActor, cancelReason ?? 'cancelled');
        if (paused) {
          await pauseMission('awaiting_plan_approval');
          if (cancelled) return await cancelMission(cancelActor, cancelReason ?? 'cancelled');
          continue;
        }
        break;
      }

      // `planDecision` is assigned by a Signal/Update handler, so the compiler cannot
      // narrow it from the assignment in this scope.
      const decision = planDecision as unknown as MissionPlanDecisionInput | null;
      if (!decision) {
        return await blockMission('plan gate closed without a decision', null, null);
      }
      if (decision.decision === 'approve') {
        await mission.appendMissionEventActivity({
          missionId: input.missionId,
          type: 'mission.plan.approved',
          actor: decision.actor,
          payload: { planVersion, reason: decision.reason ?? null },
          dedupeKey: `plan.approved:${planVersion}`,
        });
        break;
      }

      if (decision.decision === 'reject') {
        await mission.appendMissionEventActivity({
          missionId: input.missionId,
          type: 'mission.plan.rejected',
          actor: decision.actor,
          payload: { planVersion, reason: decision.reason ?? null },
          dedupeKey: `plan.rejected:${planVersion}`,
        });
        await mission.setMissionStatusActivity({
          missionId: input.missionId,
          status: 'failed',
          error: decision.reason ?? 'plan rejected',
        });
        return finish('failed', decision.reason ?? 'plan rejected');
      }

      // request_changes: re-plan with feedback, bounded.
      await mission.appendMissionEventActivity({
        missionId: input.missionId,
        type: 'mission.plan.changes_requested',
        actor: decision.actor,
        payload: {
          planVersion,
          feedback: decision.feedback ?? null,
          reason: decision.reason ?? null,
        },
        dedupeKey: `plan.changes:${planVersion}`,
      });
      feedback = decision.feedback ?? decision.reason ?? 'improve the plan';

      if (planAttempt >= MAX_PLAN_ATTEMPTS) {
        return await blockMission(
          `plan changes were requested ${MAX_PLAN_ATTEMPTS} times without an approval`,
          null,
          null,
        );
      }

      plan = null;
      await mission.appendMissionEventActivity({
        missionId: input.missionId,
        type: 'mission.replanned',
        actor: decision.actor,
        payload: { previousPlanVersion: planVersion, attempt: planAttempt + 1 },
        dedupeKey: `replanned:${planAttempt + 1}`,
      });
    }
  }

  if (!plan) {
    return await blockMission('mission has no approved plan', null, null);
  }

  await mission.setMissionStatusActivity({
    missionId: input.missionId,
    status: 'running',
    workflowId: workflowInfo().workflowId,
  });
  await mission.appendMissionEventActivity({
    missionId: input.missionId,
    type: 'mission.started',
    actor: 'orchestrator',
    payload: { planVersion },
    dedupeKey: 'started',
  });

  /* -------------------------------------------------------- milestone loop */

  const orderedMilestones = [...plan.milestones].sort((left, right) => left.order - right.order);
  const startMilestone = input.resume?.milestoneIndex ?? 0;
  let validationRound = input.resume?.validationRound ?? 0;
  let lastMilestoneId: string | null = null;

  /**
   * One validation round: scrutiny + user-testing, each a fresh child `RunWorkflow`.
   * Returns `paused`/`cancelled` instead of throwing so the caller can park the mission.
   */
  const runValidationRound = async (
    milestone: MissionMilestonePlanData,
    round: number,
    attemptBase: number,
  ): Promise<{
    kind: 'passed' | 'failed' | 'paused' | 'cancelled' | 'budget';
    findings: Record<string, unknown>[];
    attempt: number;
  }> => {
    const kinds: MissionValidationKind[] = ['scrutiny', 'user-testing'];
    let attempt = attemptBase;
    const failedFindings: Record<string, unknown>[] = [];

    for (const kind of kinds) {
      if (cancelled) return { kind: 'cancelled', findings: [], attempt };
      if (paused) return { kind: 'paused', findings: [], attempt };

      const budget = await mission.missionBudgetCheckActivity({ missionId: input.missionId });
      lastBudget = budget;
      if (budget.exceeded) {
        return { kind: 'budget', findings: [], attempt };
      }

      attempt += 1;
      const prepared = await mission.prepareMissionValidationActivity({
        missionId: input.missionId,
        milestoneId: milestone.id,
        round,
        kind,
        attempt,
      });

      await mission.appendMissionEventActivity({
        missionId: input.missionId,
        type: 'mission.validation.started',
        milestoneId: milestone.id,
        actor: kind,
        payload: {
          round,
          kind,
          runId: prepared.input.runId,
          validationId: prepared.validationId,
        },
        dedupeKey: `validation.started:${prepared.validationId}`,
      });

      childScope = new CancellationScope();
      try {
        await childScope.run(() =>
          executeChild(RunWorkflow, {
            workflowId: runWorkflowIdFor(prepared.input.runId),
            args: [prepared.input],
            workflowExecutionTimeout: '4 hours',
            workflowTaskTimeout: '30 seconds',
          }),
        );
      } catch (error) {
        if (isCancellation(error)) {
          await mission.abortMissionValidationActivity({
            validationId: prepared.validationId,
            reason: cancelled ? 'mission cancelled' : 'mission paused',
          });
          return {
            kind: cancelled ? 'cancelled' : 'paused',
            findings: [],
            attempt,
          };
        }
        throw error;
      } finally {
        childScope = null;
      }

      // Same as a feature child: a cancelled run may resolve with `cancelled` instead of
      // rejecting. Do not turn an interrupted validation into a failed contract.
      if (cancelled || paused) {
        await mission.abortMissionValidationActivity({
          validationId: prepared.validationId,
          reason: cancelled ? 'mission cancelled' : 'mission paused',
        });
        return {
          kind: cancelled ? 'cancelled' : 'paused',
          findings: [],
          attempt,
        };
      }

      const completion = await mission.completeMissionValidationActivity({
        missionId: input.missionId,
        milestoneId: milestone.id,
        validationId: prepared.validationId,
        runId: prepared.input.runId,
        round,
        kind,
      });
      if (!completion.passed) {
        // Run both validators before deciding: scrutiny owns build/unit assertions and
        // user-testing owns the browser/e2e assertions. A failure in one must not skip
        // the other, and only the combined findings drive fix features.
        failedFindings.push(
          ...completion.findings.map((finding) => ({ ...finding, validationKind: kind })),
        );
      }
    }

    if (failedFindings.length > 0) {
      return { kind: 'failed', findings: failedFindings, attempt };
    }
    return { kind: 'passed', findings: [], attempt };
  };

  for (let milestoneIndex = startMilestone; milestoneIndex < orderedMilestones.length; milestoneIndex += 1) {
    let currentMilestone = orderedMilestones[milestoneIndex] as MissionMilestonePlanData;
    lastMilestoneId = currentMilestone.id;

    let state = await mission.loadMissionStateActivity({ missionId: input.missionId });
    if (state.plan) plan = state.plan as MissionPlanData;
    currentMilestone = plan.milestones.find((entry) => entry.id === currentMilestone.id) ?? currentMilestone;

    const milestoneRow = state.milestones.find((entry) => entry.id === currentMilestone.id);
    if (milestoneRow?.status === 'done') continue;

    let statuses: Record<string, MissionFeatureStatus> = { ...state.featureStatuses };
    let round = Math.max(validationRound, milestoneRow?.validationRound ?? 0);
    let validationAttempt = 0;
    let milestoneDone = false;

    await mission.setMissionMilestoneStatusActivity({
      milestoneId: currentMilestone.id,
      status: 'running',
    });
    await mission.appendMissionEventActivity({
      missionId: input.missionId,
      type: 'mission.milestone.started',
      milestoneId: currentMilestone.id,
      actor: 'orchestrator',
      payload: { title: currentMilestone.title, order: currentMilestone.order },
      dedupeKey: `milestone.started:${currentMilestone.id}`,
    });

    while (!milestoneDone) {
      /* ------------------------------------------------------------ features */
      while (true) {
        if (cancelled) return await cancelMission(cancelActor, cancelReason ?? 'cancelled');
        if (paused) {
          await pauseMission();
          if (cancelled) return await cancelMission(cancelActor, cancelReason ?? 'cancelled');
        }

        // Read-model checks before every dispatch: a lost Signal cannot resurrect a
        // paused/cancelled mission.
        const fresh = await mission.loadMissionStateActivity({ missionId: input.missionId });
        if (fresh.plan) plan = fresh.plan as MissionPlanData;
        currentMilestone = plan.milestones.find((entry) => entry.id === currentMilestone.id) ?? currentMilestone;
        statuses = { ...fresh.featureStatuses };

        if (fresh.cancelRequested || fresh.mission.status === 'cancelled') {
          return await cancelMission(
            fresh.cancelActor,
            fresh.cancelReason ?? 'cancelled',
          );
        }
        if (fresh.mission.status === 'paused' && !paused) {
          paused = true;
          pauseActor = 'read-model';
          pauseReason = 'mission paused in the read model';
        }
        if (paused) {
          await pauseMission();
          if (cancelled) return await cancelMission(cancelActor, cancelReason ?? 'cancelled');
          continue;
        }

        const budget = await mission.missionBudgetCheckActivity({ missionId: input.missionId });
        lastBudget = budget;
        if (budget.exceeded) {
          return await budgetBlock(
            budget.reason ?? 'mission budget exhausted',
            currentMilestone.id,
            null,
          );
        }

        const next = nextRunnableMissionFeature(
          { ...plan, milestones: [currentMilestone] },
          statuses,
        );
        if (!next) break;

        const feature = next.feature;
        const created = await mission.createMissionFeatureWorkItemActivity({
          missionId: input.missionId,
          featureId: feature.id,
        });

        statuses[feature.id] = 'running';
        await mission.setMissionStatusActivity({
          missionId: input.missionId,
          status: 'running',
          currentMilestoneId: currentMilestone.id,
          currentFeatureId: feature.id,
        });
        await mission.appendMissionEventActivity({
          missionId: input.missionId,
          type: 'mission.feature.started',
          milestoneId: currentMilestone.id,
          featureId: feature.id,
          actor: 'orchestrator',
          payload: {
            title: feature.title,
            workItemId: created.workItemId,
            order: feature.order,
          },
          dedupeKey: `feature.started:${feature.id}:${created.workItemId}`,
        });

        let outcome: FactoryWorkflowOutcome | null = null;
        childScope = new CancellationScope();
        // `outcome` is assigned by the child result; the cancellation path returns above.
        try {
          outcome = await childScope.run(() =>
            executeChild(FactoryWorkflow, {
              workflowId: workItemWorkflowId(
                created.workItemId,
                created.input.attempt ?? 1,
              ),
              args: [created.input],
              workflowExecutionTimeout: '30 days',
              workflowTaskTimeout: '30 seconds',
            }),
          );
        } catch (error) {
          if (isCancellation(error)) {
            if (cancelled) {
              await mission.setMissionFeatureStatusActivity({
                featureId: feature.id,
                status: 'skipped',
              });
              return await cancelMission(cancelActor, cancelReason ?? 'cancelled');
            }
            // Paused mid-feature: the child is cancelled, the feature returns to the
            // queue, and a fresh work item is created on resume.
            await mission.setMissionFeatureStatusActivity({
              featureId: feature.id,
              status: 'pending',
            });
            statuses[feature.id] = 'pending';
            await pauseMission();
            if (cancelled) return await cancelMission(cancelActor, cancelReason ?? 'cancelled');
            continue;
          }
          throw error;
        } finally {
          childScope = null;
        }

        // A cancelled child may resolve with its own `blocked`/`cancelled` outcome instead
        // of rejecting the parent. Honour the mission's pause/cancel flags before treating
        // that outcome as a feature failure.
        if (cancelled) {
          await mission.setMissionFeatureStatusActivity({
            featureId: feature.id,
            status: 'skipped',
          });
          return await cancelMission(cancelActor, cancelReason ?? 'cancelled');
        }
        if (paused) {
          await mission.setMissionFeatureStatusActivity({
            featureId: feature.id,
            status: 'pending',
          });
          statuses[feature.id] = 'pending';
          await pauseMission();
          if (cancelled) return await cancelMission(cancelActor, cancelReason ?? 'cancelled');
          continue;
        }

        if (!outcome) {
          return await blockMission(
            'the feature child returned no outcome',
            currentMilestone.id,
            feature.id,
          );
        }

        if (outcome.status === 'done') {
          statuses[feature.id] = 'done';
          await mission.setMissionFeatureStatusActivity({
            featureId: feature.id,
            status: 'done',
            workItemId: created.workItemId,
          });
          await mission.appendMissionEventActivity({
            missionId: input.missionId,
            type: 'mission.feature.completed',
            milestoneId: currentMilestone.id,
            featureId: feature.id,
            actor: 'orchestrator',
            payload: {
              title: feature.title,
              workItemId: created.workItemId,
              prUrl: outcome.prUrl ?? null,
            },
            dedupeKey: `feature.completed:${feature.id}`,
          });
          await mission.recordMissionCheckpointActivity({
            missionId: input.missionId,
            kind: 'feature.done',
            milestoneId: currentMilestone.id,
            featureId: feature.id,
            dedupeKey: `feature:${feature.id}`,
            state: {
              title: feature.title,
              featureTitle: feature.title,
              workItemId: created.workItemId,
              prUrl: outcome.prUrl ?? null,
              planVersion,
              milestoneId: currentMilestone.id,
              featuresDone: currentMilestone.features.filter(
                (entry) => statuses[entry.id] === 'done',
              ).length,
              featuresTotal: currentMilestone.features.length,
              budget: lastBudget,
            },
          });
        } else {
          statuses[feature.id] = 'failed';
          await mission.setMissionFeatureStatusActivity({
            featureId: feature.id,
            status: 'failed',
            workItemId: created.workItemId,
          });
          await mission.appendMissionEventActivity({
            missionId: input.missionId,
            type: 'mission.feature.failed',
            milestoneId: currentMilestone.id,
            featureId: feature.id,
            actor: 'orchestrator',
            payload: {
              title: feature.title,
              workItemId: created.workItemId,
              status: outcome.status,
              reason: outcome.reason ?? null,
            },
            dedupeKey: `feature.failed:${feature.id}`,
          });
          return await blockMission(
            `feature "${feature.title}" ended ${outcome.status}${
              outcome.reason ? `: ${outcome.reason}` : ''
            }`,
            currentMilestone.id,
            feature.id,
          );
        }

        // Bounded history mid-milestone: no child is running here, and the resume state
        // only carries indices; statuses are re-read from the database.
        if (workflowInfo().continueAsNewSuggested && !paused && !cancelled) {
          return await continueAsNew<typeof MissionWorkflow>({
            ...input,
            plan,
            planVersion,
            resume: {
              planVersion,
              milestoneIndex,
              featureIndex: 0,
              validationRound: round,
            },
          });
        }
      }

      /* ---------------------------------------------------------- validation */
      const progress = missionMilestoneProgress(currentMilestone, statuses);
      if (progress.done < progress.total) {
        const failed = currentMilestone.features.find(
          (feature) => statuses[feature.id] === 'failed',
        );
        return await blockMission(
          failed
            ? `feature "${failed.title}" failed`
            : 'milestone features are not all done',
          currentMilestone.id,
          failed?.id ?? null,
        );
      }

      await mission.setMissionMilestoneStatusActivity({
        milestoneId: currentMilestone.id,
        status: 'validating',
        validationRound: round + 1,
      });
      round += 1;

      let validated = false;
      while (!validated) {
        if (cancelled) return await cancelMission(cancelActor, cancelReason ?? 'cancelled');
        if (paused) {
          await pauseMission();
          if (cancelled) return await cancelMission(cancelActor, cancelReason ?? 'cancelled');
        }

        const result = await runValidationRound(currentMilestone, round, validationAttempt);
        validationAttempt = result.attempt;

        if (result.kind === 'cancelled') {
          return await cancelMission(cancelActor, cancelReason ?? 'cancelled');
        }
        if (result.kind === 'paused') {
          await pauseMission();
          if (cancelled) return await cancelMission(cancelActor, cancelReason ?? 'cancelled');
          continue;
        }
        if (result.kind === 'budget') {
          return await budgetBlock('mission budget exhausted during validation', currentMilestone.id, null);
        }

        if (result.kind === 'passed') {
          await mission.setMissionMilestoneStatusActivity({
            milestoneId: currentMilestone.id,
            status: 'done',
            validationRound: round,
          });
          await mission.recordMissionCheckpointActivity({
            missionId: input.missionId,
            kind: 'milestone.done',
            milestoneId: currentMilestone.id,
            dedupeKey: `milestone:${currentMilestone.id}`,
            state: {
              title: currentMilestone.title,
              milestoneTitle: currentMilestone.title,
              round,
              planVersion,
              validation: 'passed',
              featuresDone: currentMilestone.features.length,
              featuresTotal: currentMilestone.features.length,
              budget: lastBudget,
            },
          });
          await mission.appendMissionEventActivity({
            missionId: input.missionId,
            type: 'mission.checkpoint',
            milestoneId: currentMilestone.id,
            actor: 'orchestrator',
            payload: { kind: 'milestone.done', round },
            dedupeKey: `milestone.done:${currentMilestone.id}`,
          });
          validated = true;
          milestoneDone = true;
          break;
        }

        // Validation failed: block at the cap, otherwise create fix features and loop
        // back through the feature phase with a new validation round.
        if (round >= MAX_VALIDATION_ROUNDS) {
          await mission.setMissionMilestoneStatusActivity({
            milestoneId: currentMilestone.id,
            status: 'blocked',
            validationRound: round,
          });
          return await blockMission(
            `milestone "${currentMilestone.title}" failed validation after ${round} rounds`,
            currentMilestone.id,
            null,
          );
        }

        // Record the failed approach + evidence before the fix features so a fresh
        // feature context can be rebuilt from checkpoints alone.
        await mission.recordMissionCheckpointActivity({
          missionId: input.missionId,
          kind: 'validation.failed',
          milestoneId: currentMilestone.id,
          dedupeKey: `validation.failed:${currentMilestone.id}:${round}`,
          state: {
            milestoneId: currentMilestone.id,
            milestoneTitle: currentMilestone.title,
            round,
            findings: result.findings,
            planVersion,
            budget: lastBudget,
          },
        });

        const fix = await mission.planFixFeaturesActivity({
          missionId: input.missionId,
          milestoneId: currentMilestone.id,
          round,
          findings: result.findings,
          planVersion,
        });
        plan = fix.plan;
        currentMilestone =
          plan.milestones.find((entry) => entry.id === currentMilestone.id) ?? currentMilestone;
        for (const feature of fix.features) statuses[feature.id] = 'pending';
        // Do not advance the round here: the next validation pass increments it once,
        // so a continue-as-new after the fix features resumes at the right round.
        await mission.setMissionMilestoneStatusActivity({
          milestoneId: currentMilestone.id,
          status: 'running',
          validationRound: round,
        });
        break;
      }

      if (!milestoneDone) {
        // Fix features were added: run them, then validate again.
        continue;
      }
    }

    validationRound = 0;

    // Bounded history at every milestone boundary (design decision 7).
    if (milestoneIndex + 1 < orderedMilestones.length) {
      return await continueAsNew<typeof MissionWorkflow>({
        ...input,
        plan,
        planVersion,
        resume: {
          planVersion,
          milestoneIndex: milestoneIndex + 1,
          featureIndex: 0,
          validationRound: 0,
        },
      });
    }
  }

  await mission.setMissionStatusActivity({
    missionId: input.missionId,
    status: 'done',
    ...(lastMilestoneId ? { currentMilestoneId: lastMilestoneId } : {}),
  });
  await mission.recordMissionCheckpointActivity({
    missionId: input.missionId,
    kind: 'mission.done',
    dedupeKey: 'mission.done',
    state: {
      planVersion,
      milestones: orderedMilestones.length,
      budget: lastBudget,
    },
  });
  await mission.appendMissionEventActivity({
    missionId: input.missionId,
    type: 'mission.done',
    actor: 'orchestrator',
    payload: { planVersion, milestones: orderedMilestones.length },
    dedupeKey: 'done',
  });

  return finish('done', undefined, lastMilestoneId, null);
}
