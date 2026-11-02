import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import {
  cleanupRuns,
  cleanupWorkItems,
  createFakeRun,
  factoryApi,
  factoryId,
  factoryPage,
  trackRun,
  trackWorkItem,
} from './helpers';

const FACTORY = 'example-lights-off';

/**
 * Canary rollout + rollback (Phase 5b, ADR-021).
 *
 * The compose stack runs the fake harness + fake forge + stub judge: no network. A scored
 * failing run makes the observer eligible; the improvement pass declares authority
 * `canary` and starts a 100% rollout so one work item deterministically routes to the
 * candidate version. The panel then shows candidate vs stable, the traffic split, the
 * window countdown and the score comparison; a manual rollback returns routing to stable
 * and records `canary.started` + `canary.rolled_back` with reason + evidence.
 */

async function calibrateScope(page: Page, request: APIRequestContext): Promise<void> {
  const run = await createFakeRun(request, {
    factory: FACTORY,
    prompt: 'e2e: canary calibration fixture',
  });
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
      name: `e2e canary calibration ${Date.now()}`,
      minSize: 1,
      threshold: 1,
      items: [{ runId: run.id, humanLabel: 'compliant' }],
    },
  });
  expect(response.ok(), `POST /api/calibration failed: ${response.status()} ${await response.text()}`).toBeTruthy();
  const body = (await response.json()) as { calibration: { verdict: string } };
  expect(body.calibration.verdict).toBe('pass');
}

/** A cancelled + scored run gives the observer a failure signal to propose from. */
async function seedFailureCorpus(page: Page, request: APIRequestContext): Promise<void> {
  const factoryIdValue = await factoryId(request, FACTORY);
  const created = await request.post(
    await factoryApi(request, FACTORY, 'chat'),
    {
      data: {
        harness: 'fake',
        fakeDelayMs: 8000,
        prompt: 'e2e: canary corpus failure',
      },
    },
  );
  expect(created.ok(), `POST chat failed: ${created.status()}`).toBeTruthy();
  const runId = ((await created.json()) as { run: { id: string } }).run.id;
  trackRun(factoryIdValue, runId);

  await request.post(
    await factoryApi(request, FACTORY, `runs/${encodeURIComponent(runId)}/cancel`),
    { data: { reason: 'e2e: canary corpus failure' } },
  );

  await page.goto(
    `/factories/${encodeURIComponent(factoryIdValue)}/runs/${encodeURIComponent(runId)}`,
  );
  await expect(page.getByTestId('run-terminal')).toContainText('cancelled', { timeout: 90_000 });

  const scored = await request.post('/api/scoring', {
    data: { factory: FACTORY, runId, force: true },
  });
  expect(scored.ok(), `POST /api/scoring failed: ${scored.status()}`).toBeTruthy();

  await expect
    .poll(
      async () => {
        const response = await request.get(`/api/scores?run=${encodeURIComponent(runId)}`);
        const body = (await response.json()) as { scores: { id: string }[] };
        return body.scores.length;
      },
      { timeout: 60_000, intervals: [500] },
    )
    .toBeGreaterThan(0);
}

interface CanaryView {
  active: {
    rollout: {
      id: string;
      status: string;
      candidateVersion: string;
      stableVersion: string;
      candidateCommit: string;
      canaryPercent: number;
    };
    split: { canaryPercent: number; stablePercent: number; candidateItems: number; stableItems: number };
    window: { remainingMs: number };
    events: { type: string; payload: Record<string, unknown> }[];
  } | null;
  history: {
    rollout: { id: string; status: string; reason: string | null };
    events: { type: string; payload: Record<string, unknown> }[];
  }[];
}

async function canaryView(request: APIRequestContext): Promise<CanaryView> {
  const url = await factoryApi(request, FACTORY, 'canary');
  const response = await request.get(url);
  expect(response.ok(), `GET ${url} failed: ${response.status()}`).toBeTruthy();
  return (await response.json()) as CanaryView;
}

async function rollbackActiveCanary(request: APIRequestContext): Promise<void> {
  const view = await canaryView(request).catch(() => null);
  if (!view?.active) return;
  await request
    .post(await factoryApi(request, FACTORY, 'canary/rollback'), {
      data: {
        rolloutId: view.active.rollout.id,
        actor: 'e2e-cleanup',
        reason: 'e2e cleanup',
      },
    })
    .catch(() => undefined);
}

test.describe('Canary rollout', () => {
  test.afterEach(async ({ request }) => {
    await rollbackActiveCanary(request);
    await cleanupWorkItems(request);
    await cleanupRuns(request);
  });

  test('rollout panel → candidate routing → manual rollback → stable routing', async ({ page, request }) => {
    test.setTimeout(420_000);

    await calibrateScope(page, request);
    await seedFailureCorpus(page, request);

    const started = await request.post(
      await factoryApi(request, FACTORY, 'improvement/run'),
      {
      data: { trigger: 'on_demand', canaryPercent: 100 },
    });
    expect(started.ok(), `POST improvement/run failed: ${started.status()} ${await started.text()}`).toBeTruthy();

    // The improvement pass ends `canary_started` and the workflow publishes the candidate;
    // the projection flips to `active` when routing has begun.
    await expect
      .poll(
        async () => {
          const view = await canaryView(request);
          return view.active?.rollout.status ?? 'none';
        },
        { timeout: 300_000, intervals: [2_000] },
      )
      .toBe('active');

    const view = await canaryView(request);
    const rollout = view.active!.rollout;
    expect(rollout.canaryPercent).toBe(100);
    expect(rollout.candidateVersion).toMatch(/^factory-v\d+-candidate$/);
    expect(rollout.candidateCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(view.active!.window.remainingMs).toBeGreaterThan(0);
    expect(view.active!.events.map((event) => event.type)).toContain('canary.started');

    // The panel projects candidate vs stable, the split, the window and the comparison.
    const factoryIdValue = await factoryId(page.request, FACTORY);
    await page.goto(`/factories/${encodeURIComponent(factoryIdValue)}/self-improvement`);
    await expect(page.getByTestId('canary-panel')).toBeVisible();
    // The rollout activates while the improvement workflow is still finishing its decision;
    // poll the server-rendered projection until the run lands `canary_started`.
    await expect
      .poll(
        async () => {
          await page.reload();
          return (await page.getByTestId('improvement-last-run-detail').textContent()) ?? '';
        },
        { timeout: 90_000, intervals: [2_000] },
      )
      .toContain('canary_started');
    await expect(page.getByTestId('canary-active')).toHaveAttribute('data-status', 'active');
    await expect(page.getByTestId('canary-status')).toHaveText('active');
    await expect(page.getByTestId('canary-candidate-version')).toHaveText(rollout.candidateVersion);
    await expect(page.getByTestId('canary-stable-version')).toHaveText(rollout.stableVersion);
    await expect(page.getByTestId('canary-split')).toHaveAttribute('data-canary-percent', '100');
    await expect(page.getByTestId('canary-split')).toHaveAttribute('data-stable-percent', '0');
    await expect(page.getByTestId('canary-window-countdown')).not.toHaveText('window elapsed');
    await expect(page.getByTestId('canary-metric-row')).toHaveCount(2);
    await expect(page.locator('[data-testid="canary-metric-row"][data-version="candidate"]')).toBeVisible();
    await expect(page.locator('[data-testid="canary-metric-row"][data-version="stable"]')).toBeVisible();
    await expect(page.locator('[data-testid="canary-event"][data-type="canary.started"]')).toHaveCount(1);

    // One work item at 100% must route to the candidate and record the rollout + commit.
    const itemResponse = await request.post(
      await factoryApi(request, FACTORY, 'work-items'),
      { data: { title: 'e2e: canary routing', harness: 'fake' } },
    );
    expect(itemResponse.ok(), `POST work-items failed: ${itemResponse.status()}`).toBeTruthy();
    const item = ((await itemResponse.json()) as {
      workItem: {
        id: string;
        definitionVersion: string;
        canaryRolloutId: string | null;
        definitionCommit: string;
      };
    }).workItem;
    trackWorkItem(factoryIdValue, item.id);
    expect(item.definitionVersion).toBe('candidate');
    expect(item.canaryRolloutId).toBe(rollout.id);
    expect(item.definitionCommit).toBe(rollout.candidateCommit);

    // The split counter reflects the routed item.
    await page.reload();
    await expect(page.getByTestId('canary-split-counts')).toContainText('1 candidate');

    // Manual rollback: routing returns to stable immediately, with an audited reason.
    await page.getByTestId('canary-actor').fill('e2e-operator');
    await page.getByTestId('canary-reason').fill('e2e: manual rollback');
    await page.getByTestId('canary-rollback').click();
    await expect(page.getByTestId('canary-action-notice')).toBeVisible({ timeout: 60_000 });

    await page.reload();
    await expect(page.getByTestId('canary-active')).toHaveCount(0);
    await expect(page.getByTestId('canary-empty')).toBeVisible();
    const historyRow = page.locator('[data-testid="canary-history-row"][data-status="rolled_back"]').first();
    await expect(historyRow).toBeVisible();
    await expect(historyRow.getByTestId('canary-history-reason')).toContainText('e2e: manual rollback');
    await expect(historyRow.locator('[data-testid="canary-history-event"][data-type="canary.started"]')).toHaveCount(1);
    await expect(historyRow.locator('[data-testid="canary-history-event"][data-type="canary.rolled_back"]')).toHaveCount(1);

    const after = await canaryView(request);
    expect(after.active).toBeNull();
    const entry = after.history.find((row) => row.rollout.id === rollout.id);
    expect(entry?.rollout.status).toBe('rolled_back');
    expect(entry?.rollout.reason).toBe('e2e: manual rollback');
    const rollbackEvent = entry?.events.find((event) => event.type === 'canary.rolled_back');
    expect(rollbackEvent?.payload).toMatchObject({
      actor: 'e2e-operator',
      reason: 'e2e: manual rollback',
      automatic: false,
    });
    expect(rollbackEvent?.payload.evidence).toMatchObject({ threshold: 0.1 });

    // Gates page reflects the canary state.
    await page.goto(`/factories/${encodeURIComponent(factoryIdValue)}/gates`);
    await expect(page.getByTestId('gates-canary-card')).toBeVisible();
    await expect(page.getByTestId('gates-canary-status')).toHaveAttribute('data-status', 'none');
    await expect(page.getByTestId('gates-canary-badge')).toContainText('rolled back');
    await expect(page.getByTestId('gates-canary-link')).toHaveAttribute(
      'href',
      `/factories/${encodeURIComponent(factoryIdValue)}/self-improvement`,
    );

    // New work returns to the stable version.
    const stableResponse = await request.post(
      await factoryApi(request, FACTORY, 'work-items'),
      { data: { title: 'e2e: canary post-rollback', harness: 'fake' } },
    );
    expect(stableResponse.ok()).toBeTruthy();
    const stableItem = ((await stableResponse.json()) as {
      workItem: { id: string; definitionVersion: string; canaryRolloutId: string | null };
    }).workItem;
    trackWorkItem(factoryIdValue, stableItem.id);
    expect(stableItem.definitionVersion).toBe('stable');
    expect(stableItem.canaryRolloutId).toBeNull();
  });
});


test('self-improvement reports canary authority separately from an active rollout', async ({ page }) => {
  await page.goto(await factoryPage(page.request, FACTORY, 'self-improvement'));
  const note = page.getByTestId('improvement-canary-note');
  await expect(note).toBeVisible();
  await expect(note).toContainText('Canary authority is enabled');
  await expect(note).not.toContainText('Canary rollout is live');
  // Active-rollout state lives in the canary panel, which says so explicitly.
  await expect(
    page.getByTestId('canary-panel').or(page.getByTestId('canary-unavailable')),
  ).toBeVisible();
});
