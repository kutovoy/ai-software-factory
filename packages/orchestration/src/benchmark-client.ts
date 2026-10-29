import { getClient } from './client';
import { loadConfig, type OrchestrationConfig } from './config';
import type { BenchmarkWorkflowInput } from './types';
import { benchmarkWorkflowId } from './types';

/**
 * Benchmark client. The API starts one `BenchmarkWorkflow` per run through this module;
 * the worker executes it. The workflow id is derived from the benchmark run id, so a
 * duplicate start is rejected instead of running the matrix twice.
 */

export interface StartedBenchmark {
  workflowId: string;
  temporalRunId: string;
}

export async function startBenchmarkWorkflow(
  input: BenchmarkWorkflowInput,
  config: OrchestrationConfig = loadConfig(),
): Promise<StartedBenchmark> {
  const client = await getClient(config);
  const workflowId = benchmarkWorkflowId(input.benchmarkRunId);
  const handle = await client.workflow.start('BenchmarkWorkflow', {
    taskQueue: config.taskQueue,
    workflowId,
    args: [input],
    workflowExecutionTimeout: '4 hours',
    workflowTaskTimeout: '30 seconds',
  });
  return { workflowId, temporalRunId: handle.firstExecutionRunId };
}

/** Diagnostics only; Postgres remains the read model for the UI. */
export async function describeBenchmark(
  benchmarkRunId: string,
  config: OrchestrationConfig = loadConfig(),
): Promise<{ status: string; workflowId: string } | null> {
  try {
    const client = await getClient(config);
    const description = await client.workflow
      .getHandle(benchmarkWorkflowId(benchmarkRunId))
      .describe();
    return { status: description.status.name, workflowId: description.workflowId };
  } catch {
    return null;
  }
}
