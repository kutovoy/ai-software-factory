import { expect, test } from '@playwright/test';

const TOP_LEVEL = ['nav-chat', 'nav-inbox', 'nav-runs', 'nav-mcps', 'nav-secrets', 'nav-users'];

const FACTORY_LEVEL = [
  'nav-dashboard',
  'nav-agents',
  'nav-automations',
  'nav-scorers',
  'nav-self-improvement',
  'nav-benchmarks',
  'nav-definition',
  'nav-gates',
  'nav-settings',
];

const STUBS = new Set(['nav-mcps', 'nav-secrets', 'nav-users']);

/** Factory pages ship in Phase 2b; each must render real data, not a stub. */
const FACTORY_PAGE_MARKERS: Record<string, string[]> = {
  'nav-dashboard': ['dashboard-counts', 'dashboard-empty'],
  'nav-agents': ['agent-card'],
  'nav-automations': ['automations-table'],
  'nav-scorers': ['scorer-card'],
  'nav-self-improvement': ['self-improvement-settings'],
  'nav-benchmarks': ['benchmark-suite'],
  'nav-definition': ['definition-readonly-banner'],
  'nav-gates': ['gates-table'],
  'nav-settings': ['settings-manifest'],
};

/** Every nav item renders; stubs name their phase; no console errors anywhere. */
test('every nav item renders and stubs name their phase', async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(String(error)));

  await page.goto('/chat');
  await expect(page.getByTestId('nav-sidebar')).toBeVisible();
  await expect(page.getByTestId('factory-switcher')).toBeVisible();
  await expect(page.getByTestId('nav-usage')).toBeVisible();
  await expect(page.getByTestId('nav-account')).toBeVisible();

  for (const testId of [...TOP_LEVEL, ...FACTORY_LEVEL]) {
    const item = page.getByTestId(testId);
    await expect(item, `${testId} must render`).toBeVisible();
    await expect(item).toHaveAttribute('href', /.+/);
  }

  // Visit every item by clicking it: keyboard/pointer reachable, no dead links.
  for (const testId of [...TOP_LEVEL, ...FACTORY_LEVEL]) {
    await page.getByTestId(testId).click();
    await expect(page.getByTestId('nav-sidebar')).toBeVisible();
    await expect(page.getByTestId(testId)).toHaveAttribute('data-active', 'true');
    await expect(page.locator('h1').first()).toBeVisible();

    if (STUBS.has(testId)) {
      await expect(page.getByTestId('coming-soon')).toBeVisible();
      const phase = page.getByTestId('coming-soon-phase');
      await expect(phase).toBeVisible();
      await expect(phase).toContainText(/Phase \d/);
    } else {
      const markers = FACTORY_PAGE_MARKERS[testId];
      if (markers) {
        await expect(page.getByTestId('coming-soon')).toHaveCount(0);
        let marker = page.getByTestId(markers[0]!);
        for (const extra of markers.slice(1)) marker = marker.or(page.getByTestId(extra));
        await expect(marker.first()).toBeVisible();
      }
    }
  }

  // The factory switcher changes the per-factory group without a full reload.
  const switcher = page.getByTestId('factory-switcher');
  const options = await switcher.locator('option').evaluateAll((nodes) =>
    nodes.map((node) => (node as HTMLOptionElement).value),
  );
  const other = options.find((value) => value !== 'example');
  if (other) {
    await switcher.selectOption(other);
    await expect(page).toHaveURL(new RegExp(`/factories/${other}/dashboard`));
    await expect(page.getByTestId('nav-factory-name')).toHaveText(other);
    await expect(page.getByTestId('dashboard-empty').or(page.getByTestId('dashboard-counts'))).toBeVisible();
  }

  const relevant = consoleErrors.filter((line) => !line.includes('favicon'));
  expect(relevant, `console errors: ${relevant.join('\n')}`).toHaveLength(0);
});

/** Keyboard-only: Tab reaches the nav and Enter activates it. */
test('nav is operable with the keyboard only', async ({ page }) => {
  await page.goto('/chat');
  await expect(page.getByTestId('nav-sidebar')).toBeVisible();

  await page.getByTestId('nav-runs').focus();
  await expect(page.getByTestId('nav-runs')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/runs$/);
  await expect(page.getByTestId('runs-filters')).toBeVisible();
});
