import { executeChild, proxyActivities, workflowInfo } from '@temporalio/workflow';
import type * as activities from '../activities';
import type {
  BenchmarkTrialOutcome,
  BenchmarkTrialPlan,
  BenchmarkWorkflowInput,
  BenchmarkWorkflowOutcome,
  RunInput,
} from '../types';
import { runWorkflowIdFor } from '../types';
import { RunWorkflow } from './run';

/**
 * BenchmarkWorkflow (Phase 4b, ADR-018/ADR-019).
 *
 * One workflow per benchmark run. It fans out hermetic child `RunWorkflow`s over the
 * (task × configuration) matrix in deterministic batches of `concurrency`; a failed trial
 * is recorded and excluded, never fatal. Before each batch it checks the hard cap: once
 * cumulative spend (plus the reserved per-trial estimate) would exceed `maxCostUsd`, the
 * remaining trials are skipped with `budget_exhausted` and the run still completes with
 * partial results.
 *
 * After the trials it aggregates per configuration, computes the Pareto frontier and
 * recommendation, and records an attestation only when the full matrix passed with
 * calibrated judges.
 */

const benchmark = proxyActivities<typeof activities>({
  startToCloseTimeout: '10 minutes',
  retry: {
    initialInterval: '500ms',
    backoffCoefficient: 2,
    maximumInterval: '30 seconds',
    maximumAttempts: 5,
  },
});

const trialScoring = proxyActivities<typeof activities>({
  startToCloseTimeout: '30 minutes',
  retry: {
    initialInterval: '1 second',
    backoffCoefficient: 2,
    maximumInterval: '1 minute',
    maximumAttempts: 3,
  },
});

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function codeOf(error: unknown): string {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    const candidate =
      (current as { type?: unknown; code?: unknown } | null)?.type ??
      (current as { code?: unknown } | null)?.code;
    if (
      typeof candidate === 'string' &&
      candidate !== 'ActivityFailure' &&
      candidate !== 'ChildWorkflowFailure'
    ) {
      return candidate;
    }
    current = (current as { cause?: unknown } | null)?.cause;
  }
  return 'trial_error';
}

export async function BenchmarkWorkflow(
  input: BenchmarkWorkflowInput,
): Promise<BenchmarkWorkflowOutcome> {
  const outcomes: BenchmarkTrialOutcome[] = [];
  let spentUsd = 0;
  let budgetExhausted = false;

  await benchmark.markBenchmarkRunningActivity({
    benchmarkRunId: input.benchmarkRunId,
    workflowId: workflowInfo().workflowId,
  }).catch(() => undefined);

  await benchmark
    .recordBenchmarkEventActivity({
      benchmarkRunId: input.benchmarkRunId,
      factory: input.factory,
      type: 'benchmark.started',
      payload: {
        suite: input.suite,
        definitionCommit: input.definitionCommit,
        configHash: input.configHash,
        trials: input.trials.length,
        estimateUsd: input.estimateUsd,
        maxCostUsd: input.maxCostUsd,
        concurrency: input.concurrency,
        fullMatrix: input.fullMatrix,
      },
    })
    .catch(() => undefined);

  const concurrency = Math.max(1, Math.min(input.concurrency, 8));
  const perTrialEstimate =
    input.trials.length > 0 ? input.estimateUsd / input.trials.length : 0;

  const runTrial = async (trial: BenchmarkTrialPlan): Promise<BenchmarkTrialOutcome> => {
    let runInput: RunInput;
    try {
      runInput = await trialScoring.startBenchmarkTrial({ input, trial });
    } catch (error) {
      return await trialScoring.failBenchmarkTrial({
        input,
        trial,
        errorCode: codeOf(error),
        error: message(error),
      });
    }

    try {
      const result = await executeChild(RunWorkflow, {
        workflowId: runWorkflowIdFor(trial.runId),
        args: [runInput],
        workflowExecutionTimeout: '2 hours',
        workflowTaskTimeout: '30 seconds',
      });
      return await trialScoring.finishBenchmarkTrial({
        input,
        trial,
        runStatus: result.status,
        ...(result.summary ? { summary: result.summary } : {}),
      });
    } catch (error) {
      return await trialScoring.finishBenchmarkTrial({
        input,
        trial,
        runStatus: 'error',
        summary: message(error),
      });
    }
  };

  for (let offset = 0; offset < input.trials.length; offset += concurrency) {
    const chunk = input.trials.slice(offset, offset + concurrency);
    const planned: BenchmarkTrialPlan[] = [];

    for (const trial of chunk) {
      const overCap = spentUsd + perTrialEstimate > input.maxCostUsd;
      if (budgetExhausted || overCap) {
        budgetExhausted = true;
        outcomes.push(
          await trialScoring.skipBenchmarkTrial({
            input,
            trial,
            reason: 'budget_exhausted',
          }),
        );
      } else {
        planned.push(trial);
      }
    }

    if (planned.length === 0) continue;

    const results = await Promise.all(planned.map(runTrial));
    for (const result of results) {
      spentUsd += result.costUsd;
      outcomes.push(result);
    }
  }

  let aggregateResult: Awaited<ReturnType<typeof trialScoring.aggregateBenchmarkActivity>>;
  try {
    aggregateResult = await trialScoring.aggregateBenchmarkActivity({ input });
  } catch (error) {
    await benchmark.finishBenchmarkRunActivity({
      benchmarkRunId: input.benchmarkRunId,
      status: 'error',
      spentUsd,
      budgetExhausted,
      error: message(error),
    });
    await benchmark
      .recordBenchmarkEventActivity({
        benchmarkRunId: input.benchmarkRunId,
        factory: input.factory,
        type: 'benchmark.completed',
        payload: { status: 'error', error: message(error), budgetExhausted },
      })
      .catch(() => undefined);
    return {
      benchmarkRunId: input.benchmarkRunId,
      status: 'error',
      passRate: null,
      calibrationOk: false,
      passed: false,
      sampleSize: 0,
      costUsd: spentUsd,
      errors: outcomes.filter((outcome) => outcome.status === 'error').length,
      skipped: outcomes.filter((outcome) => outcome.status === 'skipped').length,
      budgetExhausted,
      trials: outcomes,
      error: message(error),
    };
  }

  const attestation = await trialScoring.attestBenchmarkActivity({
    input,
    aggregate: aggregateResult.aggregate,
  });

  await benchmark.finishBenchmarkRunActivity({
    benchmarkRunId: input.benchmarkRunId,
    status: 'completed',
    spentUsd: aggregateResult.aggregate.costUsd,
    budgetExhausted,
    passRate: aggregateResult.aggregate.passRate,
    calibrationOk: aggregateResult.aggregate.calibrationOk,
    passed: aggregateResult.aggregate.passed,
  });

  await benchmark
    .recordBenchmarkEventActivity({
      benchmarkRunId: input.benchmarkRunId,
      factory: input.factory,
      type: 'benchmark.completed',
      payload: {
        status: 'completed',
        passRate: aggregateResult.aggregate.passRate,
        calibrationOk: aggregateResult.aggregate.calibrationOk,
        passed: aggregateResult.aggregate.passed,
        sampleSize: aggregateResult.aggregate.sampleSize,
        costUsd: aggregateResult.aggregate.costUsd,
        errors: aggregateResult.aggregate.errors,
        skipped: aggregateResult.aggregate.skipped,
        budgetExhausted,
        frontier: aggregateResult.analysis.frontier,
        recommendation: aggregateResult.analysis.recommendation,
        attestationId: attestation.attestationId,
        attestationReason: attestation.reason,
      },
    })
    .catch(() => undefined);

  return {
    benchmarkRunId: input.benchmarkRunId,
    status: 'completed',
    passRate: aggregateResult.aggregate.passRate,
    calibrationOk: aggregateResult.aggregate.calibrationOk,
    passed: aggregateResult.aggregate.passed,
    sampleSize: aggregateResult.aggregate.sampleSize,
    costUsd: aggregateResult.aggregate.costUsd,
    errors: aggregateResult.aggregate.errors,
    skipped: aggregateResult.aggregate.skipped,
    budgetExhausted,
    ...(attestation.attestationId ? { attestationId: attestation.attestationId } : {}),
    trials: outcomes,
  };
}
