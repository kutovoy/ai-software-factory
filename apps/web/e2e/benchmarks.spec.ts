import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { cleanupRuns, createFakeRun, factoryId, factoryPage, pauseAutonomy } from './helpers';

const FACTORY = 'example-lights-off';

/**
 * Phase 4b benchmark flow: calibrate the judge, run a 2-task × 2-configuration benchmark
 * from the dialog, read the results matrix + Pareto frontier + recommendation, and show
 * that the resulting attestation lets the Gates page enable autonomy without an override.
 *
 * The compose stack runs the fake harness + fake forge + stub judge: no network.
 */
async function calibrateScope(page: Page, request: APIRequestContext): Promise<void> {
  const run = await createFakeRun(request, {
    factory: FACTORY,
    prompt: 'e2e: benchmark calibration fixture',
  });

  // Chat runs park on the fake harness permission; approve it inline so the calibration
  // fixture reaches a terminal state.
  await page.goto(await factoryPage(page.request, FACTORY, `runs/${encodeURIComponent(run.id)}`));
  const allow = page.getByTestId('permission-allow');
  const terminal = page.getByTestId('run-terminal');
  await expect(allow.or(terminal).first()).toBeVisible({ timeout: 60_000 });
  if (await allow.isVisible()) await allow.click();
  await expect(terminal).toHaveAttribute('data-status', 'ok', { timeout: 60_000 });

  const response = await request.post('/api/calibration', {
    data: {
      factory: FACTORY,
      scorer: 'scope',
      name: `e2e benchmark calibration ${Date.now()}`,
      minSize: 1,
      threshold: 1,
      items: [{ runId: run.id, humanLabel: 'compliant' }],
    },
  });
  expect(response.ok(), `POST /api/calibration failed: ${response.status()} ${await response.text()}`).toBeTruthy();
  const body = (await response.json()) as { calibration: { verdict: string } };
  expect(body.calibration.verdict).toBe('pass');
}

async function benchmarkStatus(page: Page): Promise<string> {
  const badge = page.getByTestId('benchmark-status-badge');
  if ((await badge.count()) === 0) return 'none';
  return (await badge.first().textContent())?.trim() ?? 'none';
}

test.describe('Benchmarks', () => {
  test.afterEach(async ({ request }) => {
    await pauseAutonomy(request, FACTORY);
    await cleanupRuns(request);
  });

  test('run → results → attestation → autonomy enabled', async ({ page, request }) => {
    test.setTimeout(360_000);

    await calibrateScope(page, request);

    const factoryIdValue = await factoryId(page.request, FACTORY);
    await page.goto(`/factories/${encodeURIComponent(factoryIdValue)}/benchmarks`);
    await expect(page.getByTestId('benchmark-suite')).toHaveCount(1);
    await expect(page.getByTestId('benchmarks-count')).toContainText('1 suites');
    await expect(page.getByTestId('benchmark-run-open')).toBeVisible();

    await page.getByTestId('benchmark-run-open').click();
    await expect(page.getByTestId('benchmark-run-dialog')).toBeVisible();
    await expect(page.getByTestId('benchmark-run-configuration')).toHaveCount(2);
    await expect(page.getByTestId('benchmark-run-task')).toHaveCount(2);

    await page.getByTestId('benchmark-run-estimate').click();
    await expect(page.getByTestId('benchmark-run-estimate-result')).toBeVisible();
    await expect(page.getByTestId('benchmark-run-estimate-usd')).toContainText('$');

    // Compose thresholds keep this tiny estimate below the confirmation line; if a custom
    // threshold makes it require confirmation, tick the box instead of failing.
    const confirmBox = page.getByTestId('benchmark-run-confirm');
    if ((await confirmBox.count()) > 0) await confirmBox.check();

    await page.getByTestId('benchmark-run-cap').fill('10');
    await page.getByTestId('benchmark-run-start').click();
    await expect(page.getByTestId('benchmark-run-started')).toBeVisible();

    // The workflow runs 4 hermetic child runs; poll the server-rendered projection.
    await expect
      .poll(
        async () => {
          const factoryIdValue = await factoryId(page.request, FACTORY);
    await page.goto(`/factories/${encodeURIComponent(factoryIdValue)}/benchmarks`);
          return await benchmarkStatus(page);
        },
        { timeout: 300_000, intervals: [2_000] },
      )
      .toBe('completed');

    await expect(page.getByTestId('benchmark-results-table')).toBeVisible();
    await expect(page.getByTestId('benchmark-result-row')).toHaveCount(2);
    await expect(page.getByTestId('benchmark-pass-badge')).toContainText('passed');
    await expect(page.getByTestId('benchmark-calibration-badge')).toContainText('calibrated');
    await expect(page.getByTestId('benchmark-frontier')).toBeVisible();
    await expect(page.getByTestId('benchmark-pareto')).toBeVisible();
    await expect(page.getByTestId('benchmark-pareto-point')).toHaveCount(2);
    await expect(page.getByTestId('benchmark-recommendation')).toBeVisible();
    await expect(page.getByTestId('benchmark-trials-table')).toBeVisible();
    await expect(page.getByTestId('benchmark-trial-row')).toHaveCount(4);
    await expect(page.getByTestId('benchmark-attestation-badge')).toBeVisible();

    // The attestation unlocks the gate: no override needed.
    await page.goto(`/factories/${encodeURIComponent(factoryIdValue)}/gates`);
    await expect(page.getByTestId('gates-attestation-status')).toHaveAttribute('data-satisfied', 'true');
    await expect(page.getByTestId('gates-attestation-link')).toHaveAttribute(
      'href',
      `/factories/${encodeURIComponent(factoryIdValue)}/benchmarks`,
    );
    await expect(page.getByTestId('autonomy-attestation-ok')).toBeVisible();
    await expect(page.getByTestId('autonomy-enable')).toBeEnabled();

    await page.getByTestId('autonomy-actor').fill('e2e-operator');
    await page.getByTestId('autonomy-reason').fill('e2e: attested benchmark');
    await page.getByTestId('autonomy-enable').click();
    await expect(page.getByTestId('autonomy-state')).toHaveAttribute('data-enabled', 'true', {
      timeout: 30_000,
    });
    await expect(page.getByTestId('autonomy-state')).toHaveAttribute('data-benchmark-satisfied', 'true');
  });
});
