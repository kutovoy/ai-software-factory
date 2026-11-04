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
 * `improve-console-ops`: the console is an operations view.
 *
 * - auto-refresh control on data pages, absent on documentation routes;
 * - the factory dashboard shows state and output (items, PRs, patch), not only metrics;
 * - the selected factory survives top-level navigation (cookie-backed);
 * - the work-items board hides cancelled items by default and shows created/updated times.
 */

test.describe('console operations', () => {
  test.afterEach(async ({ request }) => {
    await cleanupWorkItems(request);
    await cleanupRuns(request);
  });

  test('auto-refresh control: default 15s, persisted, refreshes, absent on help', async ({ page }) => {
    test.setTimeout(120_000);

    await page.goto(await factoryPage(page.request, 'example'));
    const control = page.getByTestId('auto-refresh');
    await expect(control).toBeVisible();
    const select = page.getByTestId('auto-refresh-interval');
    await expect(select).toHaveValue('15');

    // The timer runs and the control reports when the data was last refreshed.
    await expect(page.getByTestId('auto-refresh-updated')).toContainText('updated', {
      timeout: 25_000,
    });

    // The choice persists across pages and reloads.
    await select.selectOption('30');
    await expect(control).toHaveAttribute('data-interval', '30');
    await page.goto(await factoryPage(page.request, 'example', 'runs'));
    await expect(page.getByTestId('auto-refresh')).toBeVisible();
    await expect(page.getByTestId('auto-refresh-interval')).toHaveValue('30');
    await page.reload();
    await expect(page.getByTestId('auto-refresh-interval')).toHaveValue('30');

    await page.goto(await factoryPage(page.request, 'example', 'work-items'));
    await expect(page.getByTestId('auto-refresh')).toBeVisible();

    // Documentation routes: no control, no timer.
    for (const route of ['/help', '/help/api']) {
      await page.goto(route);
      await expect(page.getByTestId('auto-refresh')).toHaveCount(0);
    }
  });

  test('hello-nextjs dashboard shows state, the done item, its PR and the patch', async ({ page }) => {
    test.setTimeout(90_000);

    await page.goto(await factoryPage(page.request, 'hello-nextjs'));

    // State: autonomy, canary and last activity are rendered, not just metrics.
    await expect(page.getByTestId('dashboard-state')).toBeVisible();
    await expect(page.getByTestId('dashboard-autonomy-badge')).toBeVisible();
    await expect(page.getByTestId('dashboard-canary-state')).toBeVisible();
    await expect(page.getByTestId('dashboard-last-activity')).toBeVisible();

    // The most recent completed lights-off item is listed with its status and a nested link.
    const item = page
      .locator(
        '[data-testid="dashboard-work-item"]:has([data-testid="dashboard-work-item-status"]:text-is("done"))',
      )
      .first();
    await expect(item).toBeVisible();
    await expect(item.getByTestId('dashboard-work-item-status')).toHaveText('done');
    const helloId = await factoryId(page.request, 'hello-nextjs');
    await expect(item.getByTestId('dashboard-work-item-link')).toHaveAttribute(
      'href',
      new RegExp(`^/factories/${helloId}/work-items/wi_`),
    );

    // Deliverables: the PR link, a merged count and the captured patch. A recorded PR
    // opens on the factory's own forge now (`/extras/forgejo/…`); items created before
    // add-forgejo still carry the historical `forge.local` URL, so both shapes are valid.
    await expect(page.getByTestId('dashboard-deliverables-explainer')).toBeVisible();
    await expect(page.getByTestId('dashboard-pr-link').first()).toHaveAttribute(
      'href',
      /(forge\.local|localhost:3000\/extras\/forgejo)\/acme\/hello-nextjs\/(pull|pulls)\/\d+/,
    );
    await expect(page.getByTestId('dashboard-merged-count')).not.toHaveText('0');
    // The dashboard shows artifacts from the newest runs; a chat run may be newer than the
    // factory run, so assert that at least one captured patch is visible.
    await expect(
      page.getByTestId('dashboard-artifact').filter({ hasText: 'patch.diff' }).first(),
    ).toBeVisible();

    // Recent runs carry status, harness/model and cost.
    const run = page.getByTestId('dashboard-run').first();
    await expect(run.getByTestId('dashboard-run-status')).toBeVisible();
    await expect(run.getByTestId('dashboard-run-harness')).toContainText('opencode');
    await expect(run.getByTestId('dashboard-run-cost')).toBeVisible();
    await expect(run.getByTestId('dashboard-run-started')).toBeVisible();
  });

  test('selected factory survives top-level navigation', async ({ page }) => {
    await page.goto(await factoryPage(page.request, 'example', 'runs'));

    const switcher = page.getByTestId('factory-switcher');
    const helloId = await factoryId(page.request, 'hello-nextjs');
    const optionLabel =
      (await switcher.locator(`option[value="${helloId}"]`).textContent())?.trim() ?? '';
    // The switcher shows `alias (name)`; the sidebar label is the alias, else the directory name.
    const expectedLabel = optionLabel.replace(/\s*\([^)]*\)$/, '') || 'hello-nextjs';

    await switcher.selectOption(helloId);
    await expect(page).toHaveURL(new RegExp(`/factories/${helloId}/dashboard`));
    await expect(page.getByTestId('nav-factory-name')).toHaveText(expectedLabel);

    // Clicking a top-level item must not reset the selection; Runs is factory-scoped now.
    await page.getByTestId('nav-runs').click();
    await expect(page).toHaveURL(new RegExp(`/factories/${helloId}/runs$`));
    await expect(page.getByTestId('nav-factory-name')).toHaveText(expectedLabel);
    await expect(page.getByTestId('factory-switcher')).toHaveValue(helloId);
    // Factory-scoped links keep targeting the selected factory.
    await expect(page.getByTestId('nav-dashboard')).toHaveAttribute(
      'href',
      `/factories/${helloId}/dashboard`,
    );

    // The cookie makes the selection survive a reload too.
    await page.reload();
    await expect(page.getByTestId('nav-factory-name')).toHaveText(expectedLabel);
    await expect(page.getByTestId('factory-switcher')).toHaveValue(helloId);
  });

  test('cancelled items are hidden by default and shown when toggled', async ({ page, request }) => {
    test.setTimeout(120_000);

    const exampleId = await factoryId(request, 'example');
    const created = await request.post(
      await factoryApi(request, 'example', 'work-items'),
      {
        data: {
          title: `e2e: cancelled filter ${Date.now()}`,
          type: 'task',
          source: 'manual',
          harness: 'fake',
          prompt: 'e2e: cancelled filter',
        },
      },
    );
    expect(created.ok(), `POST work-items failed: ${created.status()}`).toBeTruthy();
    const workItemId = ((await created.json()) as { workItem: { id: string } }).workItem.id;
    trackWorkItem(exampleId, workItemId);

    const cancelled = await request.post(
      await factoryApi(request, 'example', `work-items/${workItemId}/cancel`),
      { data: { actor: 'e2e', reason: 'board filter test' } },
    );
    expect(cancelled.ok(), `cancel failed: ${cancelled.status()}`).toBeTruthy();

    await expect
      .poll(
        async () => {
          const response = await request.get(
            await factoryApi(request, 'example', `work-items/${workItemId}`),
          );
          if (!response.ok()) return null;
          return ((await response.json()) as { workItem: { status: string } }).workItem.status;
        },
        { timeout: 60_000 },
      )
      .toBe('cancelled');

    await page.goto(await factoryPage(page.request, 'example', 'work-items'));
    const card = page.locator(
      `[data-testid="work-item-card"][data-work-item-id="${workItemId}"]`,
    );

    // Hidden by default; the chip reports it is off.
    await expect(page.getByTestId('work-items-status-filters')).toBeVisible();
    await expect(page.getByTestId('work-items-status-cancelled')).toHaveAttribute(
      'data-active',
      'false',
    );
    await expect(card).toHaveCount(0);

    // Toggling the chip shows exactly the cancelled item.
    await page.getByTestId('work-items-status-cancelled').click();
    await expect(page).toHaveURL(/status=/);
    await expect(page.getByTestId('work-items-status-cancelled')).toHaveAttribute(
      'data-active',
      'true',
    );
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card).toHaveAttribute('data-status', 'cancelled');

    // Created and last-updated timestamps, relative with the absolute time in the tooltip.
    await expect(card.getByTestId('work-item-card-age')).toContainText('created');
    await expect(card.getByTestId('work-item-card-updated')).toContainText('updated');
    await expect(card.getByTestId('work-item-card-updated')).toHaveAttribute(
      'title',
      /\d{4}-\d{2}-\d{2}/,
    );
  });
});
