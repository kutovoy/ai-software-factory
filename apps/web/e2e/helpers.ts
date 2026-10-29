import { expect, type APIRequestContext } from '@playwright/test';

/**
 * Every E2E-created run is tracked and cancelled in `afterEach`. A fake-harness run that
 * is left blocked on a permission holds one of the worker's 8 activity slots for up to
 * 30 minutes — enough abandoned runs would starve the queue and make the suite flaky.
 */
const created: string[] = [];

export function trackRun(runId: string | null | undefined): void {
  if (runId && !created.includes(runId)) created.push(runId);
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
