import { expect, test } from '@playwright/test';
import { cleanupRuns, createFakeRun } from './helpers';

test.afterEach(async ({ request }) => {
  await cleanupRuns(request);
});

/** Inbox = only what needs this user; every item deep-links to its run. */
test('a pending permission appears in the inbox and deep-links to the run', async ({
  page,
  request,
}) => {
  const run = await createFakeRun(request, { prompt: 'e2e: inbox permission' });

  // The permission is persisted asynchronously by the event pump.
  await expect
    .poll(
      async () => {
        await page.goto('/inbox');
        return page.locator(`[data-testid="inbox-item"][data-run-id="${run.id}"]`).count();
      },
      { timeout: 90_000 },
    )
    .toBeGreaterThan(0);

  const item = page.locator(`[data-testid="inbox-item"][data-run-id="${run.id}"]`).first();
  await expect(item).toHaveAttribute('data-kind', 'permission');
  await expect(item.getByTestId('inbox-item-kind')).toHaveText('permission');
  await expect(item.getByTestId('inbox-item-age')).toBeVisible();

  const requestId = await item.getAttribute('data-request-id');
  expect(requestId).toBeTruthy();

  await item.getByTestId('inbox-item-link').click();
  await expect(page).toHaveURL(new RegExp(`/runs/${run.id}\\?focus=permission`));

  const prompt = page.getByTestId('permission-prompt');
  await expect(prompt).toBeVisible();
  await expect(prompt).toHaveAttribute('data-request-id', requestId ?? '');
  await expect(prompt).toHaveAttribute('data-focused', 'true');

  // Act on it from the deep link; the run then reaches a terminal state.
  await page.getByTestId('permission-allow').click();
  await expect(page.getByTestId('permission-status')).toHaveText('allowed');
  await expect(page.getByTestId('run-terminal')).toBeVisible({ timeout: 60_000 });
});

test('inbox shows an explicit empty state when nothing needs attention', async ({ page }) => {
  await page.goto('/inbox');
  const empty = page.getByTestId('inbox-empty');
  const items = page.getByTestId('inbox-item');
  // Either there is work, or the empty state explains it — never a blank page.
  await expect(empty.or(items.first())).toBeVisible();
  await expect(page.locator('h1').first()).toHaveText('Inbox');
});
