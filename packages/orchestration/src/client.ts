import { Client, Connection } from '@temporalio/client';
import { loadConfig, type OrchestrationConfig } from './config';
import type { RunInput } from './types';

/**
 * Temporal client. The API starts workflows through this module only — it never talks to
 * a harness or a runner directly (ADR-001/ADR-002).
 */

export function workflowIdFor(runId: string): string {
  return `run-${runId}`;
}

let connectionPromise: Promise<Connection> | null = null;
let clientPromise: Promise<Client> | null = null;

export async function getConnection(config: OrchestrationConfig = loadConfig()): Promise<Connection> {
  connectionPromise ??= Connection.connect({
    address: config.temporalAddress,
    // Dev server has no TLS; production would set tls: true here.
  });
  return connectionPromise;
}

export async function getClient(config: OrchestrationConfig = loadConfig()): Promise<Client> {
  clientPromise ??= getConnection(config).then(
    (connection) => new Client({ connection, namespace: config.temporalNamespace }),
  );
  return clientPromise;
}

/** Test/teardown hook. */
export async function closeClient(): Promise<void> {
  if (connectionPromise) {
    const connection = await connectionPromise;
    await connection.close();
  }
  connectionPromise = null;
  clientPromise = null;
}

export interface StartedRun {
  workflowId: string;
  temporalRunId: string;
}

/** Starts one workflow per run; `workflowId` is deterministic so a duplicate start is rejected. */
export async function startRun(
  input: RunInput,
  config: OrchestrationConfig = loadConfig(),
): Promise<StartedRun> {
  const client = await getClient(config);
  const workflowId = workflowIdFor(input.runId);
  const handle = await client.workflow.start('RunWorkflow', {
    taskQueue: config.taskQueue,
    workflowId,
    args: [input],
    workflowExecutionTimeout: '7 days',
    workflowTaskTimeout: '30 seconds',
  });
  return { workflowId, temporalRunId: handle.firstExecutionRunId };
}

/** Graceful cancel: the workflow cancels the harness, appends the terminal event, kills the sandbox. */
export async function cancelRun(
  runId: string,
  reason?: string,
  config: OrchestrationConfig = loadConfig(),
): Promise<void> {
  const client = await getClient(config);
  const handle = client.workflow.getHandle(workflowIdFor(runId));
  await handle.signal('cancel', reason ?? 'cancelled');
}

export interface PermissionDecisionDelivery {
  /** `update` when the workflow accepted the decision synchronously; `signal` on fallback. */
  delivered: 'update' | 'signal';
  accepted: boolean;
}

/**
 * Delivers a human permission decision to the run workflow (ADR-013).
 *
 * Preferred channel is a Temporal **Update** (`submitPermissionDecision`): it is
 * synchronous, so the API can confirm the decision was recorded in durable workflow
 * state. If the Update is rejected (e.g. an older workflow definition, or the handler is
 * momentarily unavailable) we fall back to the equivalent **Signal**
 * (`permissionDecision`). Both handlers are registered at workflow start, so a decision
 * posted immediately after `permission.requested` cannot race handler registration.
 */
export async function submitPermissionDecision(
  input: { runId: string; requestId: string; decision: 'allow' | 'deny' | 'always' },
  config: OrchestrationConfig = loadConfig(),
): Promise<PermissionDecisionDelivery> {
  const client = await getClient(config);
  const handle = client.workflow.getHandle(workflowIdFor(input.runId));
  const payload = { requestId: input.requestId, decision: input.decision };

  try {
    const ack = await handle.executeUpdate<
      { accepted?: boolean },
      [{ requestId: string; decision: 'allow' | 'deny' | 'always' }]
    >('submitPermissionDecision', { args: [payload] });
    return { delivered: 'update', accepted: ack?.accepted !== false };
  } catch {
    await handle.signal('permissionDecision', payload);
    return { delivered: 'signal', accepted: true };
  }
}

/** Best-effort description for diagnostics; Postgres remains the read model for the UI. */
export async function describeRun(
  runId: string,
  config: OrchestrationConfig = loadConfig(),
): Promise<{ status: string; workflowId: string } | null> {
  try {
    const client = await getClient(config);
    const description = await client.workflow.getHandle(workflowIdFor(runId)).describe();
    return { status: description.status.name, workflowId: description.workflowId };
  } catch {
    return null;
  }
}

export async function temporalHealthy(
  config: OrchestrationConfig = loadConfig(),
): Promise<{ ok: boolean; address: string; error?: string }> {
  try {
    const connection = await getConnection(config);
    await connection.workflowService.getSystemInfo({});
    return { ok: true, address: config.temporalAddress };
  } catch (error) {
    return {
      ok: false,
      address: config.temporalAddress,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
