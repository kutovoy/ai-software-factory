import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import {
  cleanupRuns,
  cleanupWorkItems,
  createFakeRun,
  factoryApi,
  factoryId,
  factoryPage,
  trackWorkItem,
} from './helpers';

test.afterEach(async ({ request }) => {
  await cleanupWorkItems(request);
  await cleanupRuns(request);
});

async function resolvePermissionIfBlocked(page: Page): Promise<void> {
  const allow = page.getByTestId('permission-allow');
  const terminal = page.getByTestId('run-terminal');
  await expect(allow.or(terminal).first()).toBeVisible({ timeout: 60_000 });
  if (await allow.isVisible()) await allow.click();
}

async function scoreRun(
  request: APIRequestContext,
  factory: string,
  runId: string,
): Promise<{ id: string; label: string; status: string; uncalibrated: boolean }> {
  const factoryIdValue = await factoryId(request, factory);
  let accepted = false;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const response = await request.post(
      `/api/v1/factories/${encodeURIComponent(factoryIdValue)}/scoring`,
      { data: { runId, force: true } },
    );
    if (response.ok()) {
      accepted = true;
      break;
    }
    const body = (await response.json().catch(() => null)) as
      | { code?: string; message?: string }
      | null;
    if (
      response.status() === 400 &&
      body?.code === 'invalid_request' &&
      /not terminal/i.test(body.message ?? '')
    ) {
      // The terminal event can be visible before the run row flips to its terminal status.
      await new Promise((resolve) => setTimeout(resolve, 500));
      continue;
    }
    expect(
      response.ok(),
      `POST /api/v1/factories/${factoryIdValue}/scoring failed: ${response.status()} ${JSON.stringify(body)}`,
    ).toBeTruthy();
  }
  expect(accepted, 'scoring was never accepted for a terminal run').toBeTruthy();

  for (let attempt = 0; attempt < 120; attempt += 1) {
    const scoresResponse = await request.get(
      `/api/v1/factories/${encodeURIComponent(factoryIdValue)}/scores?run=${encodeURIComponent(runId)}`,
    );
    if (scoresResponse.ok()) {
      const body = (await scoresResponse.json()) as {
        scores?: { id: string; label: string | null; status: string; uncalibrated: boolean }[];
      };
      const score = body.scores?.[0];
      if (score) {
        return {
          id: score.id,
          label: score.label ?? '',
          status: score.status,
          uncalibrated: score.uncalibrated,
        };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`no score appeared for run ${runId}`);
}

async function waitForGate(
  request: APIRequestContext,
  workItemId: string,
  stage: string,
): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const response = await request.get(
      await factoryApi(request, 'example', `work-items/${workItemId}`),
    );
    if (response.ok()) {
      const body = (await response.json()) as { pendingGate?: { stage?: string } | null };
      if (body.pendingGate?.stage === stage) return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`work item ${workItemId} did not reach the ${stage} gate`);
}

test.describe('Scoring and measurement', () => {
  test('scorers page, score detail and run scores render real records', async ({ page, request }) => {
    test.setTimeout(180_000);

    const run = await createFakeRun(request, { prompt: 'e2e: scoring detail' });
    await page.goto(await factoryPage(page.request, run.factory, `runs/${run.id}`));
    await resolvePermissionIfBlocked(page);
    await expect(page.getByTestId('run-terminal')).toHaveAttribute('data-status', 'ok', {
      timeout: 60_000,
    });

    const score = await scoreRun(request, run.factory, run.id);
    expect(score.status).toBe('ok');
    expect(score.label).toBeTruthy();

    // Smoke (which runs before Playwright) calibrates `scope` on the shared stack, so the
    // uncalibrated flag depends on whether a passing calibration exists for this rubric hash.
    const calibrationResponse = await request.get(
      await factoryApi(request, 'example', 'calibration/scope'),
    );
    expect(calibrationResponse.ok()).toBeTruthy();
    const calibrationStatus = (await calibrationResponse.json()) as { calibrated: boolean };
    expect(score.uncalibrated).toBe(!calibrationStatus.calibrated);

    // Registry: class, labels, passing score, sampling, judge model, calibration badge.
    await page.goto(await factoryPage(page.request, 'example', 'scorers'));
    await expect(page.getByTestId('scorers-readonly-banner')).toBeVisible();
    await expect(page.getByTestId('scorers-table')).toBeVisible();
    await expect(page.getByTestId('scorers-count')).toContainText('scorer');
    await expect(page.getByTestId('scorers-budget')).toContainText(/judge budget \d+\/\d+/);

    const row = page.locator('[data-testid="scorer-row"][data-scorer="scope"]');
    await expect(row).toBeVisible();
    await expect(row.getByTestId('scorer-class')).toHaveText('judge');
    await expect(row.getByTestId('scorer-passing-score')).toHaveText('1');
    await expect(row.getByTestId('scorer-sampling-rate')).toHaveText('25%');
    await expect(row.getByTestId('scorer-judge-model')).toHaveText('anthropic/claude-haiku-4-5');
    await expect(row.getByTestId('scorer-labels')).toContainText('compliant');
    await expect(row.getByTestId('scorer-calibration')).toContainText(/uncalibrated|calibrated|insufficient/);

    // Calibration panel is honest about the current golden-set state.
    await expect(page.getByTestId('calibration-panel')).toBeVisible();
    if (calibrationStatus.calibrated) {
      await expect(page.getByTestId('calibration-verdict')).toBeVisible();
    } else {
      await expect(page.getByTestId('calibration-insufficient')).toBeVisible();
    }

    // Score detail: label/score/rationale/evidence/provenance/cost.
    const exampleId = await factoryId(page.request, 'example');
    await page.goto(`/factories/${encodeURIComponent(exampleId)}/scores/${encodeURIComponent(score.id)}`);
    await expect(page.getByTestId('score-status')).toHaveText('ok');
    await expect(page.getByTestId('score-label')).toHaveText('compliant');
    await expect(page.getByTestId('score-value')).toHaveText('1');
    await expect(page.getByTestId('score-passing')).toContainText('pass');
    await expect(page.getByTestId('score-rationale')).toContainText('stub judge');
    await expect(page.getByTestId('score-evidence').first()).toBeVisible();
    await expect(page.getByTestId('score-provenance')).toBeVisible();
    await expect(page.getByTestId('score-judge-model')).toHaveText('anthropic/claude-haiku-4-5');
    await expect(page.getByTestId('score-cost')).toBeVisible();
    if (calibrationStatus.calibrated) {
      await expect(page.getByTestId('score-uncalibrated')).toHaveCount(0);
      await expect(page.getByTestId('score-calibration')).toContainText('pass');
    } else {
      await expect(page.getByTestId('score-uncalibrated')).toBeVisible();
      await expect(page.getByTestId('score-calibration-none')).toBeVisible();
    }
    await expect(page.getByTestId('score-events')).toContainText('score.completed');

    // The run detail carries the score and links to its detail page.
    await page.goto(await factoryPage(page.request, run.factory, `runs/${run.id}`));
    await expect(page.getByTestId('run-scores')).toBeVisible();
    const scoreRow = page.locator('[data-testid="run-score-row"][data-scorer="scope"]');
    await expect(scoreRow).toBeVisible();
    await expect(scoreRow.getByTestId('run-score-label')).toHaveText('compliant');
    await expect(scoreRow.getByTestId('run-score-link')).toHaveAttribute(
      'href',
      `/factories/${encodeURIComponent(exampleId)}/scores/${encodeURIComponent(score.id)}`,
    );
  });

  test('dashboard renders metric cards with definitions and per-stage cost', async ({ page, request }) => {
    test.setTimeout(300_000);

    // A work item gives the metrics real gate/cost data (triage gate + triage run).
    const created = await request.post(
      await factoryApi(request, 'example', 'work-items'),
      {
      data: {
        title: `e2e: metrics ${Date.now()}`,
        type: 'task',
        source: 'manual',
        harness: 'fake',
        prompt: 'fix the broken readme link',
      },
    });
    expect(created.ok(), `POST work-items failed: ${created.status()}`).toBeTruthy();
    const body = (await created.json()) as { workItem: { id: string } };
    const workItemId = body.workItem.id;
    trackWorkItem(await factoryId(request, 'example'), workItemId);

    await waitForGate(request, workItemId, 'triage');
    const decision = await request.post(
      await factoryApi(request, 'example', `work-items/${workItemId}/gates/triage`),
      { data: { decision: 'approve', actor: 'e2e', reason: 'e2e: metrics data' } },
    );
    expect(decision.ok()).toBeTruthy();

    await page.goto(await factoryPage(page.request, 'example', 'dashboard?window=30d'));
    await expect(page.getByTestId('dashboard-metrics')).toBeVisible();
    await expect(page.getByTestId('metrics-window-label')).toContainText('30d');
    await expect(page.getByTestId('metrics-benchmark-gate')).toContainText(/satisfied|blocked|not required/);

    const cards = page.getByTestId('metric-card');
    await expect(cards).toHaveCount(7);
    for (const card of await cards.all()) {
      await expect(card.getByTestId('metric-definition')).not.toBeEmpty();
      const value = card.getByTestId('metric-value');
      await expect(value).toBeVisible();
      if ((await value.getAttribute('data-null')) === 'true') {
        await expect(card.getByTestId('metric-reason')).toBeVisible();
      }
    }

    // A human triage gate was decided, so automation has a real sample (0%).
    const automation = page.locator('[data-testid="metric-card"] [data-metric="automationPercent"]');
    await expect(automation).toBeVisible();
    await expect(automation).toHaveAttribute('data-null', 'false');

    // Per-stage cost breakdown (or an honest empty state) is always present.
    await expect(
      page
        .getByTestId('metrics-cost-by-stage')
        .or(page.getByTestId('metrics-cost-empty')),
    ).toBeVisible();
    await expect(page.getByTestId('cost-unattributed-row')).toBeVisible();

    // Window switching is server-side and re-computes the same honest response.
    await page.getByTestId('metrics-window-7d').click();
    await expect(page).toHaveURL(/window=7d/);
    await expect(page.getByTestId('metrics-window-label')).toContainText('7d');
  });
});
