import { proxyActivities } from '@temporalio/workflow';
import type { ScoreDraft } from '@factory/evals';
import type * as activities from '../activities';
import { errorScoreDraft, skippedScoreDraft } from '../scoring/drafts';
import type {
  ScorableRunSummary,
  ScoringPlan,
  ScoringWorkflowInput,
  ScoringWorkflowOutcome,
} from '../types';

/**
 * ScoringWorkflow — samples eligible terminal runs, runs deterministic scorers first, then
 * sampled judges, and records scores with provenance.
 *
 * Scheduling: started on-demand by `POST /scoring` (or the CLI) and on a Temporal Schedule
 * per factory (`ensureScoringSchedule`). Failure isolation: a scorer failure becomes an
 * `error` score; a judge skipped by the daily cap becomes a `skipped` score. Neither can
 * change a run — scoring consumes the run read model and never writes it.
 */

const scoring = proxyActivities<typeof activities>({
  startToCloseTimeout: '10 minutes',
  retry: {
    initialInterval: '1 second',
    backoffCoefficient: 2,
    maximumInterval: '30 seconds',
    maximumAttempts: 3,
  },
});

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function ScoringWorkflow(
  input: ScoringWorkflowInput,
): Promise<ScoringWorkflowOutcome> {
  let scoreRunId = '';
  try {
    const created = await scoring.createScoreRunActivity({
      factory: input.factory,
      runId: input.runIds?.length === 1 ? (input.runIds[0] as string) : null,
      workItemId: input.workItemId ?? null,
      stage: input.stage ?? null,
      trigger: input.trigger,
      windowDays: input.windowDays ?? null,
    });
    scoreRunId = created.scoreRunId;
  } catch (error) {
    return {
      factory: input.factory,
      scoreRunId: '',
      runs: 0,
      scorers: 0,
      scored: 0,
      errored: 0,
      skipped: 0,
      budgetExhausted: false,
      error: message(error),
    };
  }

  const finish = async (
    status: 'completed' | 'error',
    counts: {
      scorers: number;
      scored: number;
      errored: number;
      skipped: number;
      budgetExhausted: boolean;
    },
    error?: string,
  ): Promise<void> => {
    try {
      await scoring.finishScoreRunActivity({
        scoreRunId,
        status,
        scorers: counts.scorers,
        scored: counts.scored,
        skipped: counts.skipped,
        errored: counts.errored,
        budgetExhausted: counts.budgetExhausted,
        error: error ?? null,
      });
    } catch {
      // The score rows are already persisted; a missing summary row is not fatal.
    }
  };

  const persist = async (draft: ScoreDraft): Promise<boolean> => {
    try {
      await scoring.persistScore({ scoreRunId, draft });
      return true;
    } catch {
      return false;
    }
  };

  let runs: ScorableRunSummary[] = [];
  try {
    runs = await scoring.listScorableRuns({
      factory: input.factory,
      ...(input.runIds && input.runIds.length > 0 ? { runIds: input.runIds } : {}),
      ...(input.workItemId ? { workItemId: input.workItemId } : {}),
      ...(input.stage ? { stage: input.stage } : {}),
      ...(input.windowDays !== undefined ? { windowDays: input.windowDays } : {}),
    });
  } catch (error) {
    await finish(
      'error',
      { scorers: 0, scored: 0, errored: 0, skipped: 0, budgetExhausted: false },
      message(error),
    );
    return {
      factory: input.factory,
      scoreRunId,
      runs: 0,
      scorers: 0,
      scored: 0,
      errored: 0,
      skipped: 0,
      budgetExhausted: false,
      error: message(error),
    };
  }

  let plan: ScoringPlan = { items: [], budgetExhausted: false };
  try {
    plan = await scoring.planScoring({
      factory: input.factory,
      factoryRoot: input.factoryRoot,
      runs,
      ...(input.force !== undefined ? { force: input.force } : {}),
      ...(input.maxScoresPerDay !== undefined ? { maxScoresPerDay: input.maxScoresPerDay } : {}),
      ...(input.cadenceMs !== undefined ? { cadenceMs: input.cadenceMs } : {}),
    });
  } catch (error) {
    await finish(
      'error',
      { scorers: 0, scored: 0, errored: 0, skipped: 0, budgetExhausted: false },
      message(error),
    );
    return {
      factory: input.factory,
      scoreRunId,
      runs: runs.length,
      scorers: 0,
      scored: 0,
      errored: 0,
      skipped: 0,
      budgetExhausted: false,
      error: message(error),
    };
  }

  let scored = 0;
  let errored = 0;
  let skipped = 0;
  let budgetExhausted = plan.budgetExhausted;

  for (const item of plan.items) {
    if (!item.selected) {
      skipped += 1;
      if (item.reason === 'budget_exhausted') {
        budgetExhausted = true;
        await persist(
          skippedScoreDraft(
            input.factory,
            item,
            'budget_exhausted',
            'daily judge budget exhausted',
          ),
        );
      }
      continue;
    }

    let draft: ScoreDraft;
    try {
      draft =
        item.scorerClass === 'deterministic'
          ? await scoring.runDeterministic({
              factory: input.factory,
              factoryRoot: input.factoryRoot,
              runId: item.runId,
              scorer: item.scorer,
              rubricHash: item.rubricHash,
            })
          : await scoring.runJudge({
              factory: input.factory,
              factoryRoot: input.factoryRoot,
              runId: item.runId,
              scorer: item.scorer,
              rubricHash: item.rubricHash,
              ...(input.judgeMode ? { judgeMode: input.judgeMode } : {}),
            });
    } catch (error) {
      draft = errorScoreDraft(input.factory, item, 'scorer_error', message(error));
    }

    const persisted = await persist(draft);
    if (!persisted) {
      errored += 1;
      continue;
    }
    if (draft.status === 'ok') scored += 1;
    else if (draft.status === 'skipped') skipped += 1;
    else errored += 1;
  }

  const outcome: ScoringWorkflowOutcome = {
    factory: input.factory,
    scoreRunId,
    runs: runs.length,
    scorers: plan.items.length,
    scored,
    errored,
    skipped,
    budgetExhausted,
  };

  await finish('completed', {
    scorers: plan.items.length,
    scored,
    errored,
    skipped,
    budgetExhausted,
  });
  return outcome;
}
