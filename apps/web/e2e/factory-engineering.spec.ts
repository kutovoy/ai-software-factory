import { expect, test } from '@playwright/test';
import {
  cleanupRuns,
  cleanupWorkItems,
  factoryApi,
  factoryId,
  factoryPage,
  trackWorkItem,
} from './helpers';

/**
 * Factory engineering (roadmap items 1, 2, 3 and 5): the readiness projection, the
 * work-item validation contract, the dashboard outcome metrics and the Factory Stack help.
 *
 * Readiness, guard hooks and the validation projection are deterministic reads, so these
 * assertions do not depend on a model call.
 */
test.describe('factory engineering', () => {
  test.afterEach(async ({ request }) => {
    await cleanupWorkItems(request);
    await cleanupRuns(request);
  });

  test('dashboard shows the readiness card and the factory stack link', async ({ page }) => {
    await page.goto(await factoryPage(page.request, 'example'));

    await expect(page.getByTestId('dashboard-readiness')).toBeVisible();
    await expect(page.getByTestId('dashboard-readiness-link')).toBeVisible();
    await expect(page.getByTestId('dashboard-factory-stack')).toHaveAttribute(
      'href',
      '/help/concepts/factory-stack',
    );
  });

  test('readiness page shows the score, status and at least one check', async ({ page }) => {
    await page.goto(await factoryPage(page.request, 'example', 'readiness'));

    await expect(page.getByTestId('readiness-page')).toBeVisible();
    await expect(page.getByTestId('readiness-score')).toBeVisible();
    await expect(page.getByTestId('readiness-status')).toBeVisible();
    await expect(page.getByTestId('readiness-section').first()).toBeVisible();
    expect(await page.getByTestId('readiness-check').count()).toBeGreaterThan(0);
    await expect(page.getByTestId('guard-hooks-card')).toBeVisible();
  });

  test('the factory stack concept renders its diagram', async ({ page }) => {
    await page.goto('/help/concepts/factory-stack');

    await expect(page.getByTestId('help-entry-title')).toHaveText('Factory stack');
    await expect(page.getByTestId('diagram-stack')).toBeVisible();
    await expect(page.getByTestId('diagram-stack')).toContainText('Orchestration');
  });

  test('a new work item carries a validation contract panel', async ({ page }) => {
    const title = `e2e: validation contract ${Date.now()}`;
    const response = await page.request.post(await factoryApi(page.request, 'example', 'work-items'), {
      data: {
        title,
        type: 'task',
        source: 'manual',
        harness: 'fake',
        prompt: 'add the missing test that proves the fix',
      },
    });
    expect(response.ok(), `POST work-items failed: ${response.status()} ${await response.text()}`).toBeTruthy();
    const body = (await response.json()) as { workItem: { id: string } };
    trackWorkItem(await factoryId(page.request, 'example'), body.workItem.id);

    await page.goto(
      await factoryPage(
        page.request,
        'example',
        `work-items/${encodeURIComponent(body.workItem.id)}`,
      ),
    );

    await expect(page.getByTestId('work-item-validation-card')).toBeVisible();
    await expect(page.getByTestId('validation-enforce')).toBeVisible();
    await expect(page.getByTestId('validation-complete')).toBeVisible();
    // The builder always adds an acceptance check, so a fresh contract has at least one row.
    expect(await page.getByTestId('validation-check').count()).toBeGreaterThan(0);
    await expect(page.getByTestId('validation-check-status').first()).toBeVisible();
  });
});
