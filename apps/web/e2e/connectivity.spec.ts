import { expect, test } from '@playwright/test';

/**
 * Regression: an API restart must not bounce the console to `/login` or leave a white page.
 * The shell stays on the current route, the connection banner appears, and Retry clears it
 * once the health probe succeeds again.
 */
test('connection banner appears while the API is unreachable and retry recovers', async ({
  page,
}) => {
  await page.route('**/api/v1/health', (route) => route.abort());
  await page.goto('/inbox');

  await expect(page.getByTestId('server-connection')).toBeVisible({ timeout: 10_000 });
  await expect(page).toHaveURL(/\/inbox$/);

  await page.unroute('**/api/v1/health');
  await page.getByRole('button', { name: 'Retry now' }).click();

  await expect(page.getByTestId('server-connection')).toHaveCount(0, { timeout: 10_000 });
});
