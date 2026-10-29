import { expect, test } from '@playwright/test';

/**
 * The Definition page is the deliberate improvement over the reference product: a
 * read-only projection of the git-backed definition with version metadata, resolved
 * gates and a semantic diff. The Gates page is the other promoted page — a fully
 * autonomous factory must be flagged with its benchmark-gate requirement.
 */
test('definition page states it is read-only and renders version, gates, tree and diff', async ({
  page,
}) => {
  await page.goto('/factories/example/definition');

  const banner = page.getByTestId('definition-readonly-banner');
  await expect(banner).toBeVisible();
  await expect(banner).toContainText(/edited in git/i);
  await expect(banner).toContainText(/read-only/i);

  // Version: commit, tag, content hash, dirty flag.
  const versionCard = page.getByTestId('definition-version');
  await expect(versionCard).toBeVisible();
  await expect(page.getByTestId('definition-version-commit')).toHaveText(/^[0-9a-f]{40}$/);
  await expect(page.getByTestId('definition-version-hash')).toHaveText(/^[0-9a-f]{64}$/);
  await expect(page.getByTestId('definition-version-tag')).toContainText(/factory-v\d+|untagged/);
  await expect(page.getByTestId('definition-version-dirty')).toContainText(/clean|dirty/);

  // Resolved gates: every stage has a gate and a resolution source.
  const gateRows = page.getByTestId('definition-gate-row');
  await expect(gateRows).toHaveCount(6);
  for (const row of await gateRows.all()) {
    await expect(row.getByTestId('definition-gate-value')).toContainText(/human|agent|policy:/);
    await expect(row.getByTestId('definition-gate-source')).toHaveText(/automation|factory|global/);
  }

  // Resource tree, grouped by kind.
  await expect(page.getByTestId('definition-resource-tree')).toBeVisible();
  const groups = page.getByTestId('definition-resource-group');
  expect(await groups.count()).toBeGreaterThan(1);
  const foreman = page.locator('[data-testid="definition-resource-row"][data-name="foreman"]');
  await expect(foreman).toBeVisible();
  await expect(foreman).toContainText('agents/foreman/agent.md');

  // Diff: from/to selector plus an honest state (no fabricated entries).
  const diff = page.getByTestId('definition-diff');
  await expect(diff).toBeVisible();
  await expect(page.getByTestId('definition-diff-from')).toBeVisible();
  await expect(page.getByTestId('definition-diff-to')).toBeVisible();
  await expect(page.getByTestId('definition-diff-range')).toContainText(/→/);
  await expect(
    page
      .getByTestId('definition-diff-single-version')
      .or(page.getByTestId('definition-diff-empty'))
      .or(page.getByTestId('definition-diff-changes'))
      .or(page.getByTestId('definition-diff-error')),
  ).toBeVisible();
});

test('definition diff can be driven by the from/to selector', async ({ page }) => {
  await page.goto('/factories/example/definition');
  await expect(page.getByTestId('definition-diff')).toBeVisible();

  const fromSelect = page.getByTestId('definition-diff-from');
  const toSelect = page.getByTestId('definition-diff-to');
  const commit = await fromSelect.locator('option').nth(1).getAttribute('value');
  expect(commit).toMatch(/^[0-9a-f]{40}$/);

  await fromSelect.selectOption(commit!);
  await toSelect.selectOption(commit!);
  await page.getByTestId('definition-diff-submit').click();

  await expect(page).toHaveURL(/from=[0-9a-f]{40}/);
  await expect(page).toHaveURL(/to=[0-9a-f]{40}/);
  await expect(page.getByTestId('definition-diff-range')).toBeVisible();
  // Comparing a version with itself is a semantic no-op, never an invented change.
  await expect(page.getByTestId('definition-diff-empty')).toBeVisible();
  await expect(page.getByTestId('definition-diff-changes')).toHaveCount(0);
  await expect(page.getByTestId('definition-diff-reset')).toBeVisible();
});

test('gates page flags a fully autonomous factory with the benchmark gate requirement', async ({
  page,
}) => {
  await page.goto('/factories/example-lights-off/gates');

  await expect(page.getByTestId('gates-readonly-banner')).toBeVisible();
  await expect(page.getByTestId('gates-table')).toBeVisible();

  const rows = page.getByTestId('gates-row');
  await expect(rows).toHaveCount(6);
  for (const row of await rows.all()) {
    await expect(row.getByTestId('gates-row-gate')).toContainText('agent');
    await expect(row.getByTestId('gates-row-source')).toHaveText(/automation|factory|global/);
  }

  await expect(page.getByTestId('gates-autonomy-warning')).toBeVisible();
  await expect(page.getByTestId('gates-autonomy-warning')).toContainText(/benchmark/i);
  await expect(page.getByTestId('gates-merge-policy')).toHaveText('auto_on_green');
  await expect(page.getByTestId('gates-autonomy-badge')).toContainText('lights off');

  // Automation overrides are shown separately and never silently replace the table.
  await expect(page.getByTestId('gates-automation-overrides')).toBeVisible();
});

test('gates page keeps a lights-on factory explicit about human touchpoints', async ({ page }) => {
  await page.goto('/factories/example/gates');

  await expect(page.getByTestId('gates-table')).toBeVisible();
  await expect(page.getByTestId('gates-autonomy-warning')).toHaveCount(0);
  const note = page.getByTestId('gates-autonomy-note');
  await expect(note).toBeVisible();
  await expect(note).toContainText(/of 6 stages wait for a human/);
  await expect(page.getByTestId('gates-autonomy-badge')).toContainText('lights on');
});
