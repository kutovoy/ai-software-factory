import { expect, test } from '@playwright/test';
import { factoryId, factoryPage } from './helpers';

const TOP_LEVEL = ['nav-chat', 'nav-inbox', 'nav-runs', 'nav-runners', 'nav-secrets', 'nav-users'];

const FACTORY_LEVEL = [
  'nav-dashboard',
  'nav-readiness',
  'nav-agents',
  'nav-automations',
  'nav-scorers',
  'nav-mcps',
  'nav-self-improvement',
  'nav-benchmarks',
  'nav-definition',
  'nav-gates',
  'nav-merge-queue',
  'nav-settings',
];

const STUBS = new Set<string>();

/** Factory pages ship in Phase 2b; each must render real data, not a stub. */
const FACTORY_PAGE_MARKERS: Record<string, string[]> = {
  'nav-dashboard': ['dashboard-counts', 'dashboard-empty'],
  'nav-readiness': ['readiness-page'],
  'nav-agents': ['agent-card'],
  'nav-automations': ['automations-table'],
  'nav-scorers': ['scorers-registry'],
  'nav-mcps': ['mcp-registry', 'mcp-unavailable'],
  'nav-self-improvement': ['self-improvement-settings'],
  'nav-benchmarks': ['benchmark-suite'],
  'nav-definition': ['definition-readonly-banner'],
  'nav-gates': ['gates-table'],
  'nav-merge-queue': ['merge-queue-batches'],
  'nav-settings': ['settings-manifest'],
};

/** Top-level pages that must render real data (Secrets shipped in Phase 6). */
const TOP_LEVEL_MARKERS: Record<string, string[]> = {
  'nav-runners': ['runners-panel'],
  'nav-secrets': ['secrets-registry', 'secrets-unavailable'],
  'nav-users': ['users-admin', 'users-forbidden', 'users-unavailable'],
};

/** Every nav item renders; stubs name their phase; no console errors anywhere. */
test('every nav item renders and stubs name their phase', async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(String(error)));

  // Pin the selection to `example` before rendering: the factory cookie persists across
  // tests, and a factory without automations would legitimately render an empty state
  // instead of the automations table this test looks for.
  const exampleId = await factoryId(page.request, 'example');
  await page.context().addCookies([{ name: 'factory', value: exampleId, url: 'http://localhost:3000' }]);
  await page.goto('/chat');
  await expect(page.getByTestId('nav-sidebar')).toBeVisible();
  await expect(page.getByTestId('factory-switcher')).toBeVisible();
  await expect(page.getByTestId('nav-account')).toBeVisible();
  await expect(page.getByTestId('nav-github')).toBeVisible();
  await expect(page.getByTestId('nav-github')).toHaveAttribute(
    'href',
    'https://github.com/kutovoy/ai-software-factory/',
  );
  await expect(page.getByTestId('nav-github')).toHaveAttribute('target', '_blank');

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
      const markers = FACTORY_PAGE_MARKERS[testId] ?? TOP_LEVEL_MARKERS[testId];
      if (markers) {
        await expect(page.getByTestId('coming-soon')).toHaveCount(0);
        let marker = page.getByTestId(markers[0]!);
        for (const extra of markers.slice(1)) marker = marker.or(page.getByTestId(extra));
        await expect(marker.first()).toBeVisible();
      }
    }
  }

  // The factory switcher changes the per-factory group without a full reload. Its option
  // values are factory ids (change `add-factory-identity`), never directory names.
  const switcher = page.getByTestId('factory-switcher');
  const options = await switcher.locator('option').evaluateAll((nodes) =>
    nodes.map((node) => (node as HTMLOptionElement).value),
  );
  const other = options.find((value) => value !== exampleId);
  if (other) {
    const optionLabel = (await switcher.locator(`option[value="${other}"]`).textContent())?.trim() ?? '';
    // The switcher shows `alias (name)`; the sidebar label is the alias, falling back to
    // the directory name — never the manifest name, which is not path-is-identity.
    const expectedLabel = optionLabel.replace(/\s*\([^)]*\)$/, '') || other;
    await switcher.selectOption(other);
    await expect(page).toHaveURL(new RegExp(`/factories/${other}/dashboard`));
    await expect(page.getByTestId('nav-factory-name')).toHaveText(expectedLabel);
    await expect(page.getByTestId('dashboard-empty').or(page.getByTestId('dashboard-counts'))).toBeVisible();
  }

  const relevant = consoleErrors.filter((line) => !line.includes('favicon'));
  expect(relevant, `console errors: ${relevant.join('\n')}`).toHaveLength(0);
});

/** The sidebar starts expanded and collapses to an icon rail without a visible scrollbar. */
test('sidebar collapses to icons and expands again', async ({ page }) => {
  await page.goto('/chat');
  const sidebar = page.getByTestId('nav-sidebar');
  await expect(sidebar).toHaveAttribute('data-collapsed', 'false');
  const expanded = await sidebar.boundingBox();
  expect(expanded).not.toBeNull();

  await page.getByTestId('nav-collapse').click();
  await expect(sidebar).toHaveAttribute('data-collapsed', 'true');
  await expect(page.getByTestId('nav-collapse')).toHaveAttribute('aria-expanded', 'false');
  await expect
    .poll(async () => (await sidebar.boundingBox())?.width ?? 0)
    .toBeLessThan(expanded!.width);

  await page.getByTestId('nav-collapse').click();
  await expect(sidebar).toHaveAttribute('data-collapsed', 'false');
  await expect(page.getByTestId('nav-collapse')).toHaveAttribute('aria-expanded', 'true');
});

/** Keyboard-only: Tab reaches the nav and Enter activates it. */
test('nav is operable with the keyboard only', async ({ page }) => {
  // Pin the selection to `example` first: the factory cookie is persisted across tests, so
  // starting at /chat could otherwise land on whichever factory the previous test selected.
  const exampleId = await factoryId(page.request, 'example');
  await page.context().addCookies([{ name: 'factory', value: exampleId, url: 'http://localhost:3000' }]);
  await page.goto('/chat');
  await expect(page.getByTestId('nav-sidebar')).toBeVisible();
  await page.getByTestId('nav-runs').focus();
  await expect(page.getByTestId('nav-runs')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`/factories/${exampleId}/runs$`));
  await expect(page.getByTestId('runs-filters')).toBeVisible();
});


/**
 * One heading source (alias → directory name) and no horizontal overflow at 1280px.
 * Every factory page must agree with the switcher; the two demo factories must be
 * distinguishable.
 */
test('factory pages share the heading prefix and fit 1280px', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });

  const pages = [
    '/dashboard',
    '/readiness',
    '/agents',
    '/automations',
    '/benchmarks',
    '/definition',
    '/gates',
    '/merge-queue',
    '/scorers',
    '/self-improvement',
    '/settings',
  ];

  for (const factory of ['example', 'example-lights-off']) {
    const expected = factory === 'example' ? 'Example' : 'Example — lights off';
    for (const segment of pages) {
      await page.goto(await factoryPage(page.request, factory, segment.replace(/^\//, '')));
      const h1 = page.locator('h1').first();
      await expect(h1, `${factory}${segment} heading`).toContainText(expected);
      await expect(h1).toContainText('›');

      const overflow = await page.evaluate(() => {
        const width = document.documentElement.scrollWidth;
        const viewport = document.documentElement.clientWidth;
        return width > viewport + 1 ? width - viewport : 0;
      });
      expect(overflow, `${factory}${segment} overflows by ${overflow}px`).toBe(0);
    }
  }
});
