import { expect, test, type Page } from '@playwright/test';
import { cleanupRuns, cleanupWorkItems, pauseAutonomy, trackWorkItem } from './helpers';

const FACTORY = 'example-lights-off';

/**
 * Phase 3a loop, lights-off: every stage is agent-gated, so the loop runs without human
 * gates. Enabling autonomy is refused while the benchmark non-regression gate is
 * unresolved (Phase 4); the console disables the control and explains why, and an explicit
 * override {actor, reason} — confirmed in a dialog — is the only way through.
 */
test.describe('Factory loop (lights off)', () => {
  test.afterEach(async ({ request }) => {
    await pauseAutonomy(request, FACTORY);
    await cleanupWorkItems(request);
    await cleanupRuns(request);
  });

  test('autonomy needs an override and all gates auto-resolve', async ({ page }) => {
    test.setTimeout(300_000);

    await page.goto(`/factories/${FACTORY}/gates`);
    await expect(page.getByTestId('gates-table')).toBeVisible();
    await expect(page.getByTestId('autonomy-panel')).toBeVisible();

    // An earlier benchmark E2E may have left a current attestation on the shared stack.
    // Both paths are valid: with an attestation the gate is satisfied; without one the
    // control is disabled and only an explicit override {actor, reason} gets through.
    const satisfied = await page
      .getByTestId('gates-attestation-status')
      .getAttribute('data-satisfied');

    if (satisfied === 'true') {
      await expect(page.getByTestId('autonomy-attestation-ok')).toBeVisible();
      await expect(page.getByTestId('autonomy-enable')).toBeEnabled();
    } else {
      await expect(page.getByTestId('gates-attestation-status')).toHaveAttribute(
        'data-satisfied',
        'false',
      );
      await expect(page.getByTestId('autonomy-benchmark-gate-note')).toBeVisible();
      await expect(page.getByTestId('autonomy-benchmark-gate-note')).toContainText('attestation');

      // Refused: the control is disabled with an explanation, not merely unresponsive.
      await expect(page.getByTestId('autonomy-enable')).toBeDisabled();
      await expect(page.getByTestId('autonomy-enable-blocked')).toContainText('attestation missing');

      // The only way through without an attestation: an explicit override in a dialog.
      await page.getByTestId('autonomy-override-open').click();
      await expect(page.getByTestId('autonomy-override-dialog')).toBeVisible();
      await page.getByTestId('autonomy-override-actor').fill('e2e-operator');
      await page
        .getByTestId('autonomy-override-reason')
        .fill('e2e: accept the benchmark risk without an attestation');
      await page.getByTestId('autonomy-override-confirm').click();
      await expect(page.getByTestId('autonomy-override-dialog')).toHaveCount(0);
      await expect(page.getByTestId('autonomy-override-recorded')).toContainText('e2e-operator');
      await expect(page.getByTestId('autonomy-enable')).toBeEnabled();
    }

    await page.getByTestId('autonomy-actor').fill('e2e-operator');
    await page.getByTestId('autonomy-reason').fill('e2e: lights-off run');
    await page.getByTestId('autonomy-enable').click();
    await expect(page.getByTestId('autonomy-state')).toHaveAttribute('data-enabled', 'true', {
      timeout: 30_000,
    });
    await expect(page.getByTestId('autonomy-state')).toHaveAttribute(
      'data-benchmark-required',
      'true',
    );
    await expect(page.getByTestId('autonomy-state')).toHaveAttribute(
      'data-benchmark-satisfied',
      'true',
    );

    // A lights-off work item: no human gate anywhere.
    await page.goto('/work-items');
    await page.getByTestId('create-factory').selectOption(FACTORY);
    await page.getByTestId('create-harness').selectOption('fake');
    const title = `e2e: lights-off loop ${Date.now()}`;
    await page.getByTestId('create-title').fill(title);
    await page.getByTestId('create-prompt').fill('fix a flaky test in the api service');
    await page.getByTestId('create-submit').click();

    await expect(page).toHaveURL(/\/work-items\/wi_[0-9A-HJKMNP-TV-Z]{26}$/, { timeout: 30_000 });
    const workItemId = new URL(page.url()).pathname.split('/').pop() as string;
    trackWorkItem(workItemId);

    await expect
      .poll(
        async () => {
          await page.goto(`/work-items/${workItemId}`);
          return (await page.getByTestId('work-item-status').textContent())?.trim();
        },
        { timeout: 240_000, intervals: [2_000] },
      )
      .toBe('done');

    // No gate ever waited for a human.
    await expect(page.getByTestId('gate-actions')).toHaveCount(0);
    await expect(page.getByTestId('work-item-pending-gate-empty')).toBeVisible();

    // Every recorded gate decision was automatic (agent-gated).
    const decisions = page.getByTestId('gate-decision-row');
    expect(await decisions.count()).toBeGreaterThanOrEqual(6);
    for (const row of await decisions.all()) {
      await expect(row.getByTestId('gate-decision-decision')).toHaveAttribute(
        'data-automatic',
        'true',
      );
      await expect(row.getByTestId('gate-decision-decision')).toHaveAttribute(
        'data-decision',
        'approve',
      );
    }

    // Review committee still runs and stays advisory; the forge merged on the ship gate.
    await expect(page.getByTestId('reviewer-report')).toHaveCount(2);
    await expect(page.getByTestId('review-judge')).toHaveAttribute('data-advisory', 'true');
    await expect(page.getByTestId('work-item-pr')).toHaveAttribute('href', /^https:\/\/forge\.local\//);
    await expect(page.getByTestId('checks-green')).toHaveText('green');
    await expect(page.getByTestId('work-item-merged')).toBeVisible();
    await expect(page.locator('[data-testid="status-event"][data-reason*="merged"]')).toHaveCount(1);
  });
});
