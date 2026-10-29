import { expect, test, type Page } from '@playwright/test';
import { cleanupRuns, cleanupWorkItems, trackWorkItem } from './helpers';

/**
 * Phase 3a loop, lights-on: a manual work item runs triage → spec → implement → review
 * (two independent reviewers + judge) → verify → ship on the fake forge, with human gates
 * at triage/spec/ship. The review verdict is advisory and nothing merges before the ship
 * gate approves.
 */
test.describe('Factory loop (lights on)', () => {
  test.afterEach(async ({ request }) => {
    await cleanupWorkItems(request);
    await cleanupRuns(request);
  });

  test('manual item flows through every stage and merges only after the ship gate', async ({
    page,
  }) => {
    test.setTimeout(300_000);

    // Board: all seven stage columns, in order, even when a factory has no agent for one.
    await page.goto('/work-items');
    await expect(page.getByTestId('work-items-board').or(page.getByTestId('work-items-empty'))).toBeVisible();
    const columns = await page.getByTestId('board-column').evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute('data-stage')),
    );
    expect(columns).toEqual(['triage', 'spec', 'plan', 'implement', 'review', 'verify', 'ship']);

    // Filter by factory is server-side and narrows the board.
    await page.getByTestId('work-items-filter-factory').selectOption('example');
    await page.getByTestId('work-items-filter-submit').click();
    await expect(page).toHaveURL(/factory=example/);
    const factories = await page.getByTestId('work-item-card').evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute('data-factory')),
    );
    for (const factory of factories) expect(factory).toBe('example');

    // Manual creation through the console (POST /api/work-items → POST /work-items).
    await page.getByTestId('create-factory').selectOption('example');
    await page.getByTestId('create-type').selectOption('task');
    await page.getByTestId('create-harness').selectOption('fake');
    const title = `e2e: factory loop ${Date.now()}`;
    await page.getByTestId('create-title').fill(title);
    await page.getByTestId('create-prompt').fill('fix the broken README link');
    await page.getByTestId('create-submit').click();

    await expect(page).toHaveURL(/\/work-items\/wi_[0-9A-HJKMNP-TV-Z]{26}$/, { timeout: 30_000 });
    const workItemId = new URL(page.url()).pathname.split('/').pop() as string;
    trackWorkItem(workItemId);

    await expect(page.getByTestId('work-item-detail')).toHaveAttribute(
      'data-work-item-id',
      workItemId,
    );
    await expect(page.getByTestId('work-item-title')).toHaveText(title);

    // The card is on the board, with its source, age and a link to the triage run.
    await page.goto('/work-items?factory=example');
    const card = page.locator(`[data-testid="work-item-card"][data-work-item-id="${workItemId}"]`);
    await expect(card).toBeVisible({ timeout: 60_000 });
    await expect(card.getByTestId('work-item-card-status')).toHaveText('active');
    await expect(card.getByTestId('work-item-card-source')).toHaveText('manual');
    await expect(card.getByTestId('work-item-card-age')).toBeVisible();
    await expect(card.getByTestId('work-item-card-link')).toHaveAttribute(
      'href',
      `/work-items/${workItemId}`,
    );
    await expect(card.getByTestId('work-item-card-run-link').first()).toBeVisible({
      timeout: 60_000,
    });

    // Gate 1: triage (human, aliased to the spec policy).
    await expectGate(page, workItemId, 'triage', 120_000);
    await expect(page.getByTestId('gate-actions')).toHaveAttribute('data-stage', 'triage');
    await expect(page.getByTestId('gate-sla')).toBeVisible();
    await page.getByTestId('gate-approve').click();

    // Gate 2: spec.
    await expectGate(page, workItemId, 'spec', 120_000);
    await page.getByTestId('gate-approve').click();

    // implement → review (2 reviewers) → verify are agent-gated; the next human gate is ship.
    await expectGate(page, workItemId, 'ship', 180_000);

    // Stage timeline: every transition names from → to, who and why.
    const transitions = page.getByTestId('timeline-row');
    expect(await transitions.count()).toBeGreaterThanOrEqual(5);
    const toStages = await transitions.evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute('data-to')),
    );
    for (const stage of ['spec', 'implement', 'review', 'verify', 'ship']) {
      expect(toStages).toContain(stage);
    }
    const first = transitions.first();
    await expect(first).toHaveAttribute('data-from', 'triage');
    await expect(first).toHaveAttribute('data-by', 'foreman');
    await expect(first.getByTestId('timeline-reason')).toContainText('foreman dispatch');

    // Review committee: two independent reviewers and an advisory judge verdict.
    const reports = page.getByTestId('reviewer-report');
    await expect(reports).toHaveCount(2);
    for (const report of await reports.all()) {
      await expect(report).toHaveAttribute('data-verdict', 'approve');
      await expect(report.getByTestId('reviewer-confidence')).toContainText('confidence');
    }
    const judge = page.getByTestId('review-judge');
    await expect(judge).toHaveAttribute('data-verdict', 'approve');
    await expect(judge).toHaveAttribute('data-advisory', 'true');
    await expect(judge).toHaveAttribute('data-confidence', /0\.\d+/);
    await expect(page.getByTestId('judge-advisory')).toContainText('advisory only');

    // Forge: a PR exists and checks are green; nothing merged yet (ship gate still pending).
    await expect(page.getByTestId('work-item-pr')).toHaveAttribute('href', /^https:\/\/forge\.local\//);
    await expect(page.getByTestId('checks-green')).toHaveText('green');
    await expect(page.getByTestId('work-item-status')).toHaveText('active');
    await expect(page.getByTestId('work-item-not-merged')).toBeVisible();
    await expect(page.getByTestId('work-item-merged')).toHaveCount(0);
    await expect(page.locator('[data-testid="status-event"][data-reason*="merged"]')).toHaveCount(0);

    // Gate 3: ship. Only now may the loop merge.
    await expect(page.getByTestId('gate-actions')).toHaveAttribute('data-stage', 'ship');
    await page.getByTestId('gate-approve').click();

    await expect
      .poll(
        async () => {
          await page.goto(`/work-items/${workItemId}`);
          return (await page.getByTestId('work-item-status').textContent())?.trim();
        },
        { timeout: 180_000, intervals: [1_000] },
      )
      .toBe('done');

    await expect(page.getByTestId('work-item-merged')).toBeVisible();
    await expect(page.getByTestId('work-item-merged')).toContainText('merged');
    await expect(page.locator('[data-testid="status-event"][data-reason*="merged"]')).toHaveCount(1);

    const shipRow = page.getByTestId('gate-decision-row').filter({ hasText: 'ship' });
    await expect(shipRow.getByTestId('gate-decision-decision')).toHaveAttribute(
      'data-decision',
      'approve',
    );
    await expect(shipRow.getByTestId('gate-decision-decision')).toHaveAttribute(
      'data-automatic',
      'false',
    );
    await expect(shipRow.getByTestId('gate-decision-actor')).toContainText('local-user');
    await expect(shipRow.getByTestId('gate-decision-time')).not.toHaveText('—');
  });
});

/** Reloads the detail page until the pending gate is `stage` (or fails the expectation). */
async function expectGate(page: Page, workItemId: string, stage: string, timeout: number): Promise<void> {
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
