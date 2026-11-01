import { expect, test } from '@playwright/test';
import { cleanupWorkItems, trackWorkItem } from './helpers';

/**
 * Runtime hardening (harden-runtime): cancel from the board and the autonomy read model.
 *
 * The compose stack runs the fake harness/forge, so no credentials and no network are
 * involved. Both tests assert the read model, not a derived guess.
 */

const FACTORY = 'example';

test.describe('runtime hardening', () => {
  test.afterEach(async ({ request }) => {
    await cleanupWorkItems(request);
  });

  test('cancel a work item from the board (idempotent, audited)', async ({ page, request }) => {
    test.setTimeout(180_000);

    const created = await request.post('/api/work-items', {
      data: { factory: FACTORY, title: 'e2e: cancel from the board', harness: 'fake' },
    });
    expect(created.ok(), `POST /api/work-items failed: ${created.status()}`).toBeTruthy();
    const workItemId = ((await created.json()) as { workItem: { id: string } }).workItem.id;
    trackWorkItem(workItemId);

    await page.goto(`/work-items?factory=${FACTORY}`);
    const card = page.locator(`[data-testid="work-item-card"][data-work-item-id="${workItemId}"]`);
    await expect(card).toBeVisible({ timeout: 30_000 });

    await card.getByTestId('work-item-cancel-open').click();
    await card.getByTestId('work-item-cancel-actor').fill('e2e-operator');
    await card.getByTestId('work-item-cancel-reason').fill('e2e: cancel from the board');
    await card.getByTestId('work-item-cancel-submit').click();

    // The workflow cancels the in-flight stage child and ends `cancelled`.
    await expect
      .poll(
        async () => {
          const response = await request.get(`/api/work-items/${workItemId}`);
          const body = (await response.json()) as { workItem: { status: string } };
          return body.workItem.status;
        },
        { timeout: 90_000, intervals: [1_000] },
      )
      .toBe('cancelled');

    const detailResponse = await request.get(`/api/work-items/${workItemId}`);
    const detail = (await detailResponse.json()) as {
      workItem: { status: string; cancelActor: string | null; cancelReason: string | null; cancelRequestedAt: string | null };
      events: { type: string; actor: string | null; payload: Record<string, unknown> }[];
    };
    expect(detail.workItem.cancelActor).toBe('e2e-operator');
    expect(detail.workItem.cancelReason).toBe('e2e: cancel from the board');
    expect(detail.workItem.cancelRequestedAt).toBeTruthy();
    const cancelledEvents = detail.events.filter((event) => event.type === 'work_item.cancelled');
    expect(cancelledEvents).toHaveLength(1);
    expect(cancelledEvents[0]?.payload.reason).toBe('e2e: cancel from the board');
    expect(detail.events.some((event) => event.type === 'cancel.requested')).toBe(true);

    // Idempotent repeat: same terminal state, no second event.
    const repeat = await request.post(`/api/work-items/${workItemId}/cancel`, {
      data: { actor: 'e2e-operator', reason: 'e2e: repeat cancel' },
    });
    expect(repeat.ok(), `repeat cancel failed: ${repeat.status()}`).toBeTruthy();
    const repeatBody = (await repeat.json()) as {
      cancelled: boolean;
      alreadyCancelled: boolean;
      eventRecorded: boolean;
    };
    expect(repeatBody.cancelled).toBe(true);
    expect(repeatBody.alreadyCancelled).toBe(true);
    expect(repeatBody.eventRecorded).toBe(false);

    const afterRepeat = await request.get(`/api/work-items/${workItemId}`);
    const afterBody = (await afterRepeat.json()) as { events: { type: string }[] };
    expect(afterBody.events.filter((event) => event.type === 'work_item.cancelled')).toHaveLength(1);

    // `improve-console-ops`: cancelled items are hidden by default; the status chip reveals them.
    await page.reload();
    const cancelledCard = page.locator(
      `[data-testid="work-item-card"][data-work-item-id="${workItemId}"]`,
    );
    await expect(cancelledCard).toHaveCount(0);
    await page.getByTestId('work-items-status-cancelled').click();
    await expect(page).toHaveURL(/status=/);
    await expect(cancelledCard).toBeVisible({ timeout: 30_000 });
    await expect(cancelledCard).toHaveAttribute('data-status', 'cancelled');
  });

  test('Gates reads the autonomy endpoint directly', async ({ page, request }) => {
    const response = await request.get(`/api/autonomy?factory=${FACTORY}`);
    expect(response.ok(), `GET /api/autonomy failed: ${response.status()}`).toBeTruthy();
    const body = (await response.json()) as {
      autonomy: {
        factory: string;
        declared: { stages: Record<string, { gate: string }>; mergePolicy: string; fullyAutonomous: boolean };
        enabled: boolean;
        paused: boolean;
        actor: string | null;
        reason: string | null;
        updatedAt: string | null;
        everEnabled: boolean;
        lastEvent: { type: string; at: string | null } | null;
      };
    };
    const autonomy = body.autonomy;
    expect(autonomy.factory).toBe(FACTORY);
    expect(autonomy.declared.stages.spec.gate).toBeTruthy();
    expect(autonomy.declared.mergePolicy).toBeTruthy();
    // No invented timestamps: a factory that never enabled autonomy has updatedAt null.
    if (!autonomy.everEnabled) {
      expect(autonomy.updatedAt).toBeNull();
      expect(autonomy.enabled).toBe(false);
      expect(autonomy.reason).toContain('never');
    }
    if (autonomy.lastEvent) expect(autonomy.lastEvent.type.startsWith('autonomy.')).toBe(true);

    await page.goto(`/factories/${FACTORY}/gates`);
    const readState = page.getByTestId('autonomy-read-state');
    await expect(readState).toBeVisible();
    await expect(readState).toHaveAttribute('data-enabled', autonomy.enabled ? 'true' : 'false');
    await expect(readState).toHaveAttribute('data-paused', autonomy.paused ? 'true' : 'false');
    await expect(readState).toHaveAttribute('data-updated-at', autonomy.updatedAt ?? '');
    await expect(page.getByTestId('autonomy-read-reason')).toBeVisible();
    if (autonomy.lastEvent) {
      await expect(page.getByTestId('autonomy-last-event')).toHaveAttribute(
        'data-type',
        autonomy.lastEvent.type,
      );
    } else {
      await expect(page.getByTestId('autonomy-last-event-empty')).toBeVisible();
    }
  });
});
