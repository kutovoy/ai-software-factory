import { proxyActivities } from '@temporalio/workflow';
import type * as activities from '../activities';
import type { McpTestWorkflowInput, McpTestWorkflowOutcome } from '../types';

/**
 * McpTestWorkflow (spec `mcp-integration` › connection test).
 *
 * A one-shot probe: the API starts it and waits for the result; the activity runs in the
 * worker/runner host, so no credential ever reaches the API process (ADR-010).
 */

const mcp = proxyActivities<typeof activities>({
  startToCloseTimeout: '2 minutes',
  retry: {
    initialInterval: '500ms',
    backoffCoefficient: 2,
    maximumInterval: '10 seconds',
    // A failed probe is a result, not a transient error: retrying cannot fix a missing
    // command, and the UI needs the recorded failure.
    maximumAttempts: 1,
  },
});

export async function McpTestWorkflow(input: McpTestWorkflowInput): Promise<McpTestWorkflowOutcome> {
  return await mcp.testMcpServerActivity(input);
}
