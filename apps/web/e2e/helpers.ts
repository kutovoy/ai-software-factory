import { expect, type APIRequestContext } from '@playwright/test';

/**
 * Every E2E-created run is tracked and cancelled in `afterEach`. A fake-harness run that
 * is left blocked on a permission holds one of the worker's 8 activity slots for up to
 * 30 minutes — enough abandoned runs would starve the queue and make the suite flaky.
 */
const created: string[] = [];
const createdWorkItems: string[] = [];

export function trackRun(runId: string | null | undefined): void {
  if (runId && !created.includes(runId)) created.push(runId);
}

export function trackWorkItem(workItemId: string | null | undefined): void {
  if (workItemId && !createdWorkItems.includes(workItemId)) createdWorkItems.push(workItemId);
}

export async function createFakeRun(
  request: APIRequestContext,
  data: Record<string, unknown> = {},
): Promise<{ id: string; factory: string; definitionCommit: string }> {
  const response = await request.post('/api/chat', {
    data: {
      factory: 'example',
      harness: 'fake',
      prompt: 'e2e: fake harness run',
      ...data,
    },
  });
  expect(response.ok(), `POST /api/chat failed: ${response.status()} ${await response.text()}`).toBeTruthy();
  const body = (await response.json()) as { run: { id: string; factory: string; definitionCommit: string } };
  trackRun(body.run.id);
  return body.run;
}

export async function cleanupRuns(request: APIRequestContext): Promise<void> {
  for (const runId of created.splice(0)) {
    await request
      .post(`/api/runs/${runId}/cancel`, { data: { reason: 'e2e cleanup' } })
      .catch(() => undefined);
  }
}

/**
 * Best-effort work-item cleanup. There is no cancel endpoint for a work item yet, so a
 * pending gate is rejected (which ends the loop as `cancelled`). An item parked in a stage
 * run without a gate is polled briefly; if no gate appears we record the id and move on —
 * the test itself is expected to drive its items to a terminal state.
 */
export async function cleanupWorkItems(request: APIRequestContext): Promise<void> {
  for (const workItemId of createdWorkItems.splice(0)) {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const response = await request
        .get(`/api/work-items/${workItemId}`)
        .catch(() => undefined);
      if (!response || !response.ok()) break;
      const detail = (await response.json()) as {
        workItem?: { status?: string };
        pendingGate?: { stage?: string } | null;
      };
      const status = detail.workItem?.status;
      if (status === 'done' || status === 'cancelled') break;
      const stage = detail.pendingGate?.stage;
      if (!stage) {
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        continue;
      }
      await request
        .post(`/api/work-items/${workItemId}/gates/${stage}`, {
          data: { decision: 'reject', actor: 'e2e-cleanup', reason: 'e2e cleanup' },
        })
        .catch(() => undefined);
      break;
    }
  }
}

/** Restores the kill switch after a test enabled autonomy for a factory. */
export async function pauseAutonomy(
  request: APIRequestContext,
  factory: string,
): Promise<void> {
  await request
    .post('/api/autonomy', {
      data: {
        factory,
        enabled: false,
        actor: 'e2e-cleanup',
        reason: 'e2e cleanup: restore the kill switch',
      },
    })
    .catch(() => undefined);
}
