import { proxyActivities, workflowInfo } from '@temporalio/workflow';
import type * as activities from '../activities';
import type { AutomationWorkflowInput, AutomationWorkflowOutcome } from '../types';

/**
 * AutomationWorkflow (spec `automations` › scheduled automations).
 *
 * A Temporal schedule starts this workflow once per fire. The fire timestamp is the
 * idempotency key: it is the workflow's own `startTime` (stable across replays and retries),
 * so a replayed schedule or a retried activity never creates a second work item.
 */

const automation = proxyActivities<typeof activities>({
  startToCloseTimeout: '5 minutes',
  retry: {
    initialInterval: '1 second',
    backoffCoefficient: 2,
    maximumInterval: '30 seconds',
    maximumAttempts: 5,
  },
});

export async function AutomationWorkflow(
  input: AutomationWorkflowInput,
): Promise<AutomationWorkflowOutcome> {
  const fireAt = input.fireAt ?? new Date(workflowInfo().startTime).toISOString();
  return await automation.fireAutomationActivity({ ...input, fireAt });
}
