import { expect, test, type Page } from '@playwright/test';
import {
  cleanupRuns,
  cleanupWorkItems,
  factoryId,
  factoryPage,
  pauseAutonomy,
  trackWorkItem,
} from './helpers';

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

    const factoryIdValue = await factoryId(page.request, FACTORY);
    await page.goto(`/factories/${encodeURIComponent(factoryIdValue)}/gates`);
    await expect(page.getByTestId('gates-table').first()).toBeVisible();
    await expect(page.getByTestId('autonomy-panel').first()).toBeVisible();

    // An earlier benchmark E2E may have left a current attestation on the shared stack.
    // Both paths are valid: with an attestation the gate is satisfied; without one the
    // control is disabled and only an explicit override {actor, reason} gets through.
    const satisfied = await page
      .getByTestId('gates-attestation-status')
      .first()
      .getAttribute('data-satisfied');

    if (satisfied === 'true') {
      await expect(page.getByTestId('autonomy-attestation-ok').first()).toBeVisible();
      await expect(page.getByTestId('autonomy-enable').first()).toBeEnabled();
    } else {
      await expect(page.getByTestId('gates-attestation-status').first()).toHaveAttribute(
        'data-satisfied',
        'false',
      );
      await expect(page.getByTestId('autonomy-benchmark-gate-note').first()).toBeVisible();
      await expect(page.getByTestId('autonomy-benchmark-gate-note').first()).toContainText('attestation');

      // Refused: the control is disabled with an explanation, not merely unresponsive.
      await expect(page.getByTestId('autonomy-enable').first()).toBeDisabled();
      await expect(page.getByTestId('autonomy-enable-blocked').first()).toContainText('attestation missing');

      // The only way through without an attestation: an explicit override in a dialog.
      await page.getByTestId('autonomy-override-open').first().click();
      await expect(page.getByTestId('autonomy-override-dialog').first()).toBeVisible();
      await page.getByTestId('autonomy-override-actor').first().fill('e2e-operator');
      await page
        .getByTestId('autonomy-override-reason')
        .first()
        .fill('e2e: accept the benchmark risk without an attestation');
      await page.getByTestId('autonomy-override-confirm').first().click();
      await expect(page.getByTestId('autonomy-override-dialog').first()).toHaveCount(0);
      await expect(page.getByTestId('autonomy-override-recorded').first()).toContainText('e2e-operator');
      await expect(page.getByTestId('autonomy-enable').first()).toBeEnabled();
    }

    await page.getByTestId('autonomy-actor').first().fill('e2e-operator');
    await page.getByTestId('autonomy-reason').first().fill('e2e: lights-off run');
    await page.getByTestId('autonomy-enable').first().click();
    await expect(page.getByTestId('autonomy-state').first()).toHaveAttribute('data-enabled', 'true', {
      timeout: 30_000,
    });
    await expect(page.getByTestId('autonomy-state').first()).toHaveAttribute(
      'data-benchmark-required',
      'true',
    );
    await expect(page.getByTestId('autonomy-state').first()).toHaveAttribute(
      'data-benchmark-satisfied',
      'true',
    );

    // A lights-off work item: no human gate anywhere.
    await page.goto(
      `/factories/${encodeURIComponent(factoryIdValue)}/work-items`,
    );
    await page.getByTestId('create-harness').first().selectOption('fake');
    const title = `e2e: lights-off loop ${Date.now()}`;
    await page.getByTestId('create-title').first().fill(title);
    await page.getByTestId('create-prompt').first().fill('fix a flaky test in the api service');
    await page.getByTestId('create-submit').first().click();

    await expect(page).toHaveURL(
      new RegExp(`/factories/${factoryIdValue}/work-items/wi_[0-9A-HJKMNP-TV-Z]{26}$`),
      { timeout: 30_000 },
    );
    const workItemId = new URL(page.url()).pathname.split('/').pop() as string;
    const detailPath = `/factories/${encodeURIComponent(factoryIdValue)}/work-items/${workItemId}`;
    trackWorkItem(factoryIdValue, workItemId);

    await expect
      .poll(
        async () => {
          await page.goto(detailPath);
          return (await page.getByTestId('work-item-status').first().textContent())?.trim();
        },
        { timeout: 240_000, intervals: [2_000] },
      )
      .toBe('done');

    // No gate ever waited for a human.
    await expect(page.getByTestId('gate-actions').first()).toHaveCount(0);
    await expect(page.getByTestId('work-item-pending-gate-empty').first()).toBeVisible();

    // Every recorded gate decision was automatic (agent-gated).
    const decisions = page.locator('[data-testid="gate-decision-row"]:visible');
    expect(await decisions.count()).toBeGreaterThanOrEqual(6);
    for (const row of await decisions.all()) {
      await expect(row.getByTestId('gate-decision-decision').first()).toHaveAttribute(
        'data-automatic',
        'true',
      );
      await expect(row.getByTestId('gate-decision-decision').first()).toHaveAttribute(
        'data-decision',
        'approve',
      );
    }

    // Review committee still runs and stays advisory; the forge merged on the ship gate.
    const reports = page.locator('[data-testid="reviewer-report"]:visible');
    await expect.poll(() => reports.count(), { timeout: 30_000 }).toBeGreaterThanOrEqual(2);
    await expect(page.getByTestId('review-judge').first()).toHaveAttribute('data-advisory', 'true');

    // The deterministic review packet is visible for the item and names its risk tier.
    const packet = page.locator('[data-testid="work-item-review-packet"]:visible').first();
    await expect(packet).toBeVisible({ timeout: 30_000 });
    await expect(packet).toHaveAttribute('data-risk-tier', /^(low|medium|high)$/);
    await expect(page.getByTestId('review-packet-risk').first()).toContainText('risk');

    await expect(page.getByTestId('work-item-pr').first()).toHaveAttribute('href', /^https:\/\/forge\.local\//);
    await expect(page.getByTestId('checks-green').first()).toHaveText('green');
    await expect(page.getByTestId('work-item-merged').first()).toBeVisible();
    await expect(
      page.locator('[data-testid="status-event"][data-reason*="merged"]').first(),
    ).toBeVisible();
  });
});
