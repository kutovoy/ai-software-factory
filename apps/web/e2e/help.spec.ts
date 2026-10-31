import { expect, test } from '@playwright/test';

/**
 * Help centre (`web-console` spec: "Help centre", "Contextual help", "No dead controls").
 * Runs against the compose stack like the rest of the suite.
 */
test('help nav opens the index, filters, and reaches the quick start', async ({ page }) => {
  await page.goto('/chat');
  await expect(page.getByTestId('nav-help')).toBeVisible();
  await page.getByTestId('nav-help').click();

  await expect(page).toHaveURL(/\/help$/);
  await expect(page.getByTestId('help-title')).toHaveText('Help centre');
  await expect(page.getByTestId('help-index')).toBeVisible();

  // All five Diátaxis sections render with entries.
  for (const section of ['quick-start', 'concepts', 'menu', 'factories', 'troubleshooting']) {
    await expect(page.locator(`[data-testid="help-section"][data-section="${section}"]`)).toBeVisible();
  }

  // Client-side filter narrows by title/section/summary.
  await page.getByTestId('help-search').fill('gates');
  await expect(page.getByTestId('help-entry-link').filter({ hasText: 'Gates' }).first()).toBeVisible();
  await expect(page.getByTestId('help-result-count')).not.toContainText('0 of');

  await page.getByTestId('help-search').fill('no-such-topic-xyz');
  await expect(page.getByTestId('help-no-results')).toBeVisible();
  await page.getByTestId('help-search').fill('');

  // The quick start has the three hand-built diagrams and a success checklist.
  await page.getByTestId('help-entry-link').filter({ hasText: 'Quick start' }).first().click();
  await expect(page).toHaveURL(/\/help\/quick-start$/);
  await expect(page.getByTestId('help-entry-title')).toHaveText('Quick start');
  await expect(page.getByTestId('diagram-pipeline')).toBeVisible();
  await expect(page.getByTestId('diagram-anatomy')).toBeVisible();
  await expect(page.getByTestId('diagram-gates')).toBeVisible();
  await expect(page.getByTestId('help-checklist')).toContainText('SMOKE PASSED');
  await expect(page.getByTestId('help-code').filter({ hasText: 'docker compose up' })).toBeVisible();

  // Help pages link back to the page they describe (the quick start has none) and to the index.
  await page.getByTestId('help-back-link').click();
  await expect(page).toHaveURL(/\/help$/);
});

test('the contextual ? resolves Chat, Gates and Self-improvement', async ({ page }) => {
  await page.goto('/chat');
  const control = page.getByTestId('help-context-link');
  await expect(control).toBeVisible();
  await expect(control).toHaveAttribute('href', '/help/chat');
  await expect(control).toHaveAccessibleName('Help for New Chat');
  await expect(control).toHaveAttribute('data-help-slug', 'chat');

  await page.goto('/factories/example/gates');
  await expect(page.getByTestId('help-context-link')).toHaveAttribute('href', '/help/factories/gates');
  await expect(page.getByTestId('help-context-link')).toHaveAccessibleName('Help for Gates');

  await page.goto('/factories/example/self-improvement');
  await expect(page.getByTestId('help-context-link')).toHaveAttribute(
    'href',
    '/help/factories/self-improvement',
  );
  await expect(page.getByTestId('help-context-link')).toHaveAccessibleName('Help for Self-improvement');

  // Clicking it lands on the entry, which links back to the page it describes.
  await page.getByTestId('help-context-link').click();
  await expect(page).toHaveURL(/\/help\/factories\/self-improvement$/);
  await expect(page.getByTestId('help-entry-title')).toHaveText('Self-improvement');
  await expect(page.getByTestId('help-page-link')).toHaveAttribute(
    'href',
    '/factories/example/self-improvement',
  );

  // An unknown route falls back to the index instead of a 404 entry.
  await page.goto('/no-such-route');
  await expect(page.getByTestId('help-context-link')).toHaveAttribute('href', '/help');
  await expect(page.getByTestId('help-context-link')).toHaveAccessibleName('Help for this page');
  await page.getByTestId('help-context-link').click();
  await expect(page).toHaveURL(/\/help$/);
});

test('the Factories + is an honest link to the add-factory how-to', async ({ page }) => {
  await page.goto('/chat');

  // The old dead span and its apology title are gone.
  await expect(page.locator('[title="Creating factories is not wired yet"]')).toHaveCount(0);
  const factoriesHeader = page.getByTestId('nav-sidebar').locator('text=FACTORIES');
  await expect(factoriesHeader).toBeVisible();

  const add = page.getByRole('link', { name: 'Add a factory (git-backed)' });
  await expect(add).toBeVisible();
  await expect(add).toHaveAttribute('href', '/help/factories/add');
  await expect(page.getByTestId('nav-add-factory')).toHaveAttribute(
    'aria-label',
    'Add a factory (git-backed)',
  );

  await add.click();
  await expect(page).toHaveURL(/\/help\/factories\/add$/);
  await expect(page.getByTestId('help-entry-title')).toHaveText('Add a factory');
  await expect(page.getByTestId('help-entry-status')).toContainText('git-backed');
  await expect(page.getByTestId('help-entry')).toContainText('never writes the worktree');
  await expect(page.getByTestId('help-checklist')).toContainText('factory validate');

  // The Help entry sits at the bottom of the sidebar, above the account footer.
  const helpBox = await page.getByTestId('nav-help').boundingBox();
  const accountBox = await page.getByTestId('nav-account').boundingBox();
  expect(helpBox).not.toBeNull();
  expect(accountBox).not.toBeNull();
  expect(helpBox!.y).toBeLessThan(accountBox!.y);
});
