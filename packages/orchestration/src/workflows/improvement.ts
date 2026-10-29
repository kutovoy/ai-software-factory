import { proxyActivities, workflowInfo } from '@temporalio/workflow';
import type * as activities from '../activities';
import type {
  ImprovementProposalOutcome,
  ImprovementWorkflowInput,
  ImprovementWorkflowOutcome,
} from '../types';

/**
 * ImprovementWorkflow (Phase 5, spec `self-improvement`, ADR-020).
 *
 * One workflow per improvement run: eligibility → observe → dedupe → probe → compose →
 * decide. An ineligible corpus or a corpus with no failure signal completes as `skipped`
 * / `no_improvement` instead of inventing work. Every step is an activity so a retry
 * resumes at the last durable boundary; events are deduped by `(run, type, subject)`.
 */

const improve = proxyActivities<typeof activities>({
  startToCloseTimeout: '10 minutes',
  retry: {
    initialInterval: '500ms',
    backoffCoefficient: 2,
    maximumInterval: '30 seconds',
    maximumAttempts: 5,
  },
});

const decide = proxyActivities<typeof activities>({
  startToCloseTimeout: '5 minutes',
  retry: {
    initialInterval: '500ms',
    backoffCoefficient: 2,
    maximumInterval: '30 seconds',
    maximumAttempts: 3,
  },
});

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function decisionSummary(outcomes: ImprovementProposalOutcome[]): string {
  const statuses = new Set(outcomes.map((outcome) => outcome.status));
  if (statuses.has('merged')) return 'merged';
  if (statuses.has('pr_open')) return 'pr_opened';
  if (statuses.has('canary_not_available')) return 'canary_not_available';
  if (statuses.has('rejected')) return 'rejected';
  return 'no_improvement';
}

export async function ImprovementWorkflow(
  input: ImprovementWorkflowInput,
): Promise<ImprovementWorkflowOutcome> {
  const runId = input.improvementRunId;
  let eligibility: Record<string, unknown> = {};
  let proposalIds: string[] = [];

  try {
    await improve.startImprovementRunActivity({
      input,
      workflowId: workflowInfo().workflowId,
    });
    await improve.markImprovementRunningActivity({
      improvementRunId: runId,
      workflowId: workflowInfo().workflowId,
    });

    await improve
      .recordImprovementEventActivity({
        improvementRunId: runId,
        factory: input.factory,
        type: 'improvement.started',
        payload: {
          trigger: input.trigger,
          authority: input.authority,
          definitionCommit: input.definitionCommit,
          minScoredRuns: input.minScoredRuns,
          windowDays: input.windowDays,
          maxProbes: input.maxProbes,
        },
      })
      .catch(() => undefined);

    const assessed = await improve.assessImprovementEligibilityActivity({ input });
    eligibility = assessed.eligibility as unknown as Record<string, unknown>;

    if (!assessed.eligibility.eligible) {
      await improve.finishImprovementRunActivity({
        improvementRunId: runId,
        status: 'skipped',
        eligibility,
        proposals: 0,
        lessons: 0,
        decision: 'ineligible',
      });
      return {
        improvementRunId: runId,
        status: 'skipped',
        decision: 'ineligible',
        proposals: [],
        lessons: [],
        eligibility,
      };
    }

    const observed = await improve.observeImprovementActivity({
      input,
      corpus: assessed.corpus,
    });
    const persisted = await improve.persistImprovementProposalsActivity({
      input,
      proposals: observed,
    });
    proposalIds = persisted
      .filter((entry) => entry.proposal.status === 'open')
      .map((entry) => entry.proposal.id);

    if (proposalIds.length === 0) {
      const outcomes = await improve.summarizeImprovementProposalsActivity({
        proposalIds: persisted.map((entry) => entry.proposal.id),
        probeResults: [],
      });
      await improve.finishImprovementRunActivity({
        improvementRunId: runId,
        status: 'completed',
        eligibility,
        proposals: outcomes.length,
        lessons: 0,
        decision: 'no_improvement',
      });
      return {
        improvementRunId: runId,
        status: 'completed',
        decision: 'no_improvement',
        proposals: outcomes,
        lessons: [],
        eligibility,
      };
    }

    const probeResults = await improve.probeImprovementActivity({ input, proposalIds });
    const composed = await improve.composeImprovementActivity({ input, probeResults });

    if (composed.length === 0) {
      const outcomes = await improve.summarizeImprovementProposalsActivity({
        proposalIds,
        probeResults,
      });
      await improve.finishImprovementRunActivity({
        improvementRunId: runId,
        status: 'completed',
        eligibility,
        proposals: outcomes.length,
        lessons: 0,
        decision: 'no_improvement',
      });
      return {
        improvementRunId: runId,
        status: 'completed',
        decision: 'no_improvement',
        proposals: outcomes,
        lessons: [],
        eligibility,
      };
    }

    const decisions = await decide.decideImprovementActivity({ input, composed });

    const proposals = await decide.getProposalRecordsActivity({
      proposalIds: composed.map((entry) => entry.proposalId),
    });
    const lessons = await decide.recordImprovementLessonsActivity({
      input,
      proposals,
      decisions,
      probeResults,
    });
    const outcomes = await decide.summarizeImprovementProposalsActivity({
      proposalIds: proposals.map((proposal) => proposal.id),
      probeResults,
    });
    const decision = decisionSummary(outcomes);

    await improve.finishImprovementRunActivity({
      improvementRunId: runId,
      status: 'completed',
      eligibility,
      proposals: outcomes.length,
      lessons: lessons.length,
      decision,
    });

    return {
      improvementRunId: runId,
      status: 'completed',
      decision,
      proposals: outcomes,
      lessons,
      eligibility,
    };
  } catch (error) {
    const detail = message(error);
    await improve
      .finishImprovementRunActivity({
        improvementRunId: runId,
        status: 'error',
        eligibility,
        proposals: proposalIds.length,
        lessons: 0,
        decision: 'error',
        error: detail,
      })
      .catch(() => undefined);
    return {
      improvementRunId: runId,
      status: 'error',
      decision: 'error',
      proposals: [],
      lessons: [],
      eligibility,
      error: detail,
    };
  }
}
