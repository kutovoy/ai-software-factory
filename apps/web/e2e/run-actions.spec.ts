import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { cleanupRuns, cleanupWorkItems, createFakeRun, trackWorkItem } from './helpers';

/**
 * Contextual run actions (spec `web-console` › Contextual run actions, `factory-loop` ›
 * Work-item retry).
 *
 * A terminal run never renders a dead "Cancel run" button. A factory stage run offers no
 * per-run retry — retry belongs to its work item, which re-opens the item at its current
 * stage under a new attempt. The compose stack runs the fake harness, so the loop reaches
 * a human gate deterministically and `request_changes` at the first stage escalates.
 */

test.describe('Run and work-item actions', () => {
  test.afterEach(async ({ request }) => {
    await cleanupWorkItems(request);
    await cleanupRuns(request);
  });

  test('a terminal run has no cancel control and a chat run keeps retry-as-new', async ({
    page,
    request,
  }) => {
    const run = await createFakeRun(request, { prompt: 'e2e: terminal run actions' });

    await page.goto(`/runs/${run.id}`);

    // The fake harness may block on one interactive permission; approve it so the run
    // reaches a terminal state (the stage runs of a factory item auto-allow).
    const allow = page.getByTestId('permission-allow');
    const terminal = page.getByTestId('run-terminal');
    await expect(allow.or(terminal).first()).toBeVisible({ timeout: 60_000 });
    if (await allow.isVisible()) await allow.click();
    await expect(terminal).toBeVisible({ timeout: 60_000 });

    // The header is server-rendered: reload so it reflects the terminal status.
    await page.reload();

    // Terminal: the cancel control is gone, the end state is shown instead.
    await expect(page.getByTestId('run-cancel')).toHaveCount(0);
    const state = page.getByTestId('run-terminal-state');
    await expect(state).toBeVisible();
    await expect(state).toContainText('ok');

    // A chat run belongs to no work item: no work-item link, and retry-as-new only for a
    // failed/cancelled run (this one is `ok`).
    await expect(page.getByTestId('run-retry-work-item')).toHaveCount(0);
    await expect(page.getByTestId('run-retry-button')).toHaveCount(0);
  });

  test('an escalated work item is retried from its page under a new attempt', async ({
    page,
    request,
  }) => {
    test.setTimeout(300_000);

    const workItemId = await createFakeWorkItem(request, 'e2e: retry an escalated item');
    await expectGate(page, workItemId, 'triage', 180_000);

    // The triage stage run is terminal (`ok`) and owned by the item: no cancel, no per-run
    // retry, and the page links to the work item where retry lives.
    const suffix = workItemId.replace(/^wi_/, '');
    await page.goto(`/runs/run_${suffix}_triage_1`);
    await expect(page.getByTestId('run-terminal-state')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('run-cancel')).toHaveCount(0);
    await expect(page.getByTestId('run-retry-button')).toHaveCount(0);
    await expect(page.getByTestId('run-retry-work-item')).toHaveAttribute(
      'href',
      `/work-items/${workItemId}`,
    );

    // Escalate deterministically: request_changes at the first stage has nowhere to loop
    // back to, so the loop escalates to a human.
    const decision = await request.post(`/api/work-items/${workItemId}/gates/triage`, {
      data: {
        decision: 'request_changes',
        actor: 'e2e-operator',
        feedback: 'e2e: force escalation',
      },
    });
    expect(decision.ok(), `gate decision failed: ${decision.status()}`).toBeTruthy();

    await expect
      .poll(
        async () => {
          const response = await request.get(`/api/work-items/${workItemId}`);
          const body = (await response.json()) as { workItem: { status: string } };
          return body.workItem.status;
        },
        { timeout: 120_000, intervals: [1_000] },
      )
      .toBe('escalated');

    await page.goto(`/work-items/${workItemId}`);
    await expect(page.getByTestId('work-item-status')).toHaveText('escalated');
    await expect(page.getByTestId('work-item-retry-open')).toBeVisible();

    await page.getByTestId('work-item-retry-open').click();
    await page.getByTestId('work-item-retry-actor').fill('e2e-operator');
    await page.getByTestId('work-item-retry-reason').fill('e2e: retry after escalation');
    await page.getByTestId('work-item-retry-submit').click();

    // The read model is the truth: the item is active again, on attempt 2.
    await expect(page.getByTestId('work-item-status')).toHaveText('active', { timeout: 60_000 });
    await expect(page.getByTestId('work-item-attempt')).toContainText('attempt 2');
    await expect(page.getByTestId('work-item-attempt-value')).toContainText('2');
    await expect(page.getByTestId('work-item-retried-events')).toBeVisible();
    const retried = page.getByTestId('retried-event').first();
    await expect(retried).toHaveAttribute('data-previous-status', 'escalated');
    await expect(retried).toHaveAttribute('data-attempt', '2');
    await expect(retried).toHaveAttribute('data-actor', 'e2e-operator');

    // The audit names the new attempt workflow, and a second stage run was dispatched.
    const detailResponse = await request.get(`/api/work-items/${workItemId}`);
    const detail = (await detailResponse.json()) as {
      workItem: { status: string; attempt: number; workflowId: string | null };
      workflowId: string;
      events: { type: string; payload: Record<string, unknown> }[];
    };
    expect(detail.workItem.status).toBe('active');
    expect(detail.workItem.attempt).toBe(2);
    expect(detail.workflowId).toBe(`factory-${workItemId}-a2`);
    const retriedEvent = detail.events.find((event) => event.type === 'work_item.retried');
    expect(retriedEvent?.payload).toMatchObject({
      previousStatus: 'escalated',
      actor: 'e2e-operator',
      attempt: 2,
      workflowId: `factory-${workItemId}-a2`,
    });

    // The re-dispatched stage records its attempt in the audit.
    await expect
      .poll(
        async () => {
          const response = await request.get(`/api/work-items/${workItemId}`);
          const body = (await response.json()) as {
            events: { type: string; payload: Record<string, unknown> }[];
          };
          return body.events.filter(
            (event) => event.type === 'dispatch.requested' && event.payload.stage === 'triage',
          ).length;
        },
        { timeout: 120_000, intervals: [1_000] },
      )
      .toBeGreaterThanOrEqual(2);
  });
});

async function createFakeWorkItem(
  request: APIRequestContext,
  title: string,
): Promise<string> {
  const response = await request.post('/api/work-items', {
    data: { factory: 'example', title, harness: 'fake' },
  });
  expect(response.ok(), `POST /api/work-items failed: ${response.status()}`).toBeTruthy();
  const workItemId = ((await response.json()) as { workItem: { id: string } }).workItem.id;
  trackWorkItem(workItemId);
  return workItemId;
}

/** Reloads the detail page until the pending gate is `stage` (or fails the expectation). */
async function expectGate(
  page: Page,
  workItemId: string,
  stage: string,
  timeout: number,
): Promise<void> {
  await expect
    .poll(
      async () => {
        try {
          await page.goto(`/work-items/${workItemId}`);
        } catch {
          return 'navigation-error';
        }
        const gate = page.getByTestId('gate-actions');
        if ((await gate.count()) === 0) return 'none';
        return (await gate.first().getAttribute('data-stage')) ?? 'unknown';
      },
      { timeout, intervals: [1_000] },
    )
    .toBe(stage);
}
