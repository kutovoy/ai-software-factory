import { getClient } from './client';
import { loadConfig, type OrchestrationConfig } from './config';
import type { McpTestWorkflowInput, McpTestWorkflowOutcome } from './types';
import { mcpTestWorkflowId } from './types';

/**
 * MCP probe client. The workflow runs in the worker, where the runner lives (ADR-010):
 * the API never spawns a server or reads a credential. We start the workflow and await its
 * result so `POST /factories/:name/mcp/:server/test` can answer with the recorded outcome.
 */
export async function runMcpTest(
  input: McpTestWorkflowInput,
  config: OrchestrationConfig = loadConfig(),
): Promise<{ workflowId: string; outcome: McpTestWorkflowOutcome }> {
  const client = await getClient(config);
  const workflowId = mcpTestWorkflowId(input.factory, input.server, new Date().toISOString());
  const handle = await client.workflow.start('McpTestWorkflow', {
    taskQueue: config.taskQueue,
    workflowId,
    args: [input],
    workflowExecutionTimeout: '5 minutes',
    workflowTaskTimeout: '30 seconds',
  });
  const outcome = (await handle.result()) as McpTestWorkflowOutcome;
  return { workflowId, outcome };
}
