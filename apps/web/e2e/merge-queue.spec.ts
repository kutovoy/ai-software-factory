import { expect, test } from '@playwright/test';
import { cleanupRuns, cleanupWorkItems, trackWorkItem } from './helpers';

const FACTORY = 'example';

/**
 * Phase 3b: GitHub integration settings, the merge queue and the automation wiring
 * (spec `code-forge`, `merge-queue`, `automations`; ADR-022 / ADR-023).
 *
 * The compose stack runs the fake forge, so the whole chain is offline: the console sends a
 * secret *name* (never a value), the queue owns the merge, and the automations page shows
 * the real Temporal schedule status.
 */

test.describe('Integrations, merge queue and automations', () => {
  test.afterEach(async ({ request }) => {
    // Leave the factory on the Phase-3a behaviour so a later loop spec still merges on ship.
    await request
      .post('/api/integrations/github', {
        data: {
          factory: FACTORY,
          secretRef: 'GITHUB_TOKEN',
          webhookSecretRef: 'GITHUB_WEBHOOK_SECRET',
          repos: [{ owner: 'acme', name: 'api-service' }],
          events: ['issues'],
          labels: ['factory-ready'],
          dryRun: true,
          mergeQueue: false,
        },
      })
      .catch(() => undefined);
    await cleanupWorkItems(request);
    await cleanupRuns(request);
  });

  test('settings names the local forge and links to it', async ({ page, request }) => {
    await page.goto(`/factories/${FACTORY}/settings`);
    const card = page.getByTestId('settings-local-forge');
    await expect(card).toBeVisible();
    await expect(page.getByTestId('settings-forgejo-mode')).toContainText('single-user');
    // The multi-user path is stated, not implied (spec `forge` › Mode is stated).
    await expect(card).toContainText('OIDC');
    await expect(page.getByTestId('settings-open-forgejo')).toHaveAttribute('href', '/extras/forgejo/');

    const forge = await request.get('/extras/forgejo/');
    expect(forge.status()).toBe(200);
    expect(await forge.text()).toContain('Forgejo');
  });

  test('settings saves a GitHub connection by secret reference', async ({ page, request }) => {
    await page.goto(`/factories/${FACTORY}/settings`);
    await expect(page.getByTestId('settings-github-integration')).toBeVisible();
    await expect(page.getByTestId('settings-github-webhook-url')).toContainText('/webhooks/github');

    await page.getByTestId('github-secret-ref-input').fill('GITHUB_TOKEN');
    await page.getByTestId('github-webhook-secret-ref-input').fill('GITHUB_WEBHOOK_SECRET');
    await page.getByTestId('github-repos-input').fill('acme/api-service');
    await page.getByTestId('github-events-input').fill('issues');
    await page.getByTestId('github-labels-input').fill('factory-ready');
    if (!(await page.getByTestId('github-dry-run-input').isChecked())) {
      await page.getByTestId('github-dry-run-input').check();
    }
    if (await page.getByTestId('github-merge-queue-input').isChecked()) {
      await page.getByTestId('github-merge-queue-input').uncheck();
    }
    await page.getByTestId('github-save').click();
    await expect(page.getByTestId('github-form-notice')).toContainText('saved');

    await page.reload();
    await expect(page.getByTestId('settings-github-status')).toContainText(/dry run|connected|secret missing/);
    await expect(page.getByTestId('settings-github-secret-ref')).toContainText('GITHUB_TOKEN');
    await expect(page.getByTestId('settings-github-webhook-secret-ref')).toContainText(
      'GITHUB_WEBHOOK_SECRET',
    );
    await expect(page.getByTestId('settings-github-repo-row')).toHaveCount(1);
    await expect(page.getByTestId('settings-github-repo-row')).toContainText('acme/api-service');
    await expect(page.getByTestId('settings-github-filters')).toContainText('factory-ready');

    // The API projection never carries a token value.
    const response = await request.get(`/api/factories/${FACTORY}/integrations`);
    expect(response.ok()).toBeTruthy();
    const body = (await response.json()) as { github: { secretRef: string } };
    expect(body.github.secretRef).toBe('GITHUB_TOKEN');
  });

  test('a queued pull request is merged by the queue and shown on the merge queue page', async ({
    page,
    request,
  }) => {
    test.setTimeout(420_000);

    const created = await request.post('/api/work-items', {
      data: {
        factory: FACTORY,
        title: `e2e: merge queue ${Date.now()}`,
        harness: 'fake',
        mergeQueue: true,
        prompt: 'e2e: merge queue change',
      },
    });
    expect(created.ok(), `POST /api/work-items failed: ${created.status()}`).toBeTruthy();
    const workItemId = ((await created.json()) as { workItem: { id: string } }).workItem.id;
    trackWorkItem(workItemId);

    // Lights-on gates: triage and spec are human, then the ship gate enqueues the PR.
    await expectGate(page, workItemId, 'triage', 120_000);
    await page.getByTestId('gate-approve').click();
    await expectGate(page, workItemId, 'spec', 120_000);
    await page.getByTestId('gate-approve').click();
    await expectGate(page, workItemId, 'ship', 240_000);
    await page.getByTestId('gate-approve').click();

    // The queue merges the batch in the worker.
    await expect
      .poll(
        async () => {
          const response = await request.get(`/api/factories/${FACTORY}/merge-queue`);
          if (!response.ok()) return 'error';
          const body = (await response.json()) as {
            batches: { status: string; items: { prNumber: number; status: string }[] }[];
          };
          const batch = body.batches[0];
          return batch ? `${batch.status}:${batch.items[0]?.status ?? 'none'}` : 'none';
        },
        { timeout: 180_000, intervals: [2_000] },
      )
      .toBe('merged:merged');

    await page.goto(`/factories/${FACTORY}/merge-queue`);
    await expect(page.getByTestId('merge-queue-batch-size')).toContainText('batch size');
    // The projection is newest first; earlier batches from other runs may still be listed.
    const batchCard = page.getByTestId('merge-queue-batch').first();
    await expect(batchCard).toHaveAttribute('data-status', 'merged');
    await expect(batchCard.getByTestId('merge-queue-batch-status')).toHaveText('merged');
    await expect(batchCard.getByTestId('merge-queue-item-row')).toHaveCount(1);
    await expect(batchCard.getByTestId('merge-queue-item-status')).toHaveText('merged');
    await expect(batchCard.getByTestId('merge-queue-batch-checks')).toContainText('ci:success');
    await expect(batchCard.getByTestId('merge-queue-batch-base')).toContainText('base');
    await expect(batchCard.getByTestId('merge-queue-batch-merge')).toContainText('merge');
    await expect(
      batchCard.locator('[data-testid="merge-queue-event"][data-type="merge.batch.merged"]'),
    ).toHaveCount(1);
    await expect(batchCard.getByTestId('merge-queue-event').first()).toBeVisible();

    // The item is done and links to the PR the queue merged.
    await page.goto(`/work-items/${workItemId}`);
    await expect(page.getByTestId('work-item-status')).toHaveText('done');
    await expect(page.getByTestId('work-item-pr')).toHaveAttribute('href', /^https:\/\/forge\.local\//);
  });

  test('automations page shows webhook and cron status, and pausing stops the schedule', async ({
    page,
    request,
  }) => {
    const synced = await request.post('/api/automations/sync', { data: { factory: FACTORY } });
    expect(synced.ok(), `POST /api/automations/sync failed: ${synced.status()}`).toBeTruthy();

    await page.goto(`/factories/${FACTORY}/automations`);
    await expect(page.getByTestId('automations-table')).toBeVisible();
    await expect(page.getByTestId('automations-webhook-url')).toContainText('/webhooks/github');
    await expect(page.getByTestId('automations-webhook-secret')).toContainText(
      'GITHUB_WEBHOOK_SECRET',
    );

    const nightly = page.locator('[data-testid="automation-row"]').filter({ hasText: 'Nightly maintenance' });
    await expect(nightly.getByTestId('automation-schedule-status')).toHaveAttribute(
      'data-status',
      'active',
    );
    await expect(nightly.getByTestId('automation-last-fire')).toContainText('last fire');

    const intake = page.locator('[data-testid="automation-row"]').filter({ hasText: 'intake' });
    await expect(intake.getByTestId('automation-webhook-events')).toContainText('issue_labeled');

    // Pausing the cron schedule records the operator; the projection flips to paused.
    const paused = await request.post(`/api/automations/${FACTORY}/nightly/pause`, {
      data: { actor: 'e2e-operator', reason: 'e2e: pause the nightly pass' },
    });
    expect(paused.ok(), `pause failed: ${paused.status()}`).toBeTruthy();
    await page.reload();
    await expect(nightly.getByTestId('automation-schedule-status')).toHaveAttribute(
      'data-status',
      'paused',
    );

    // Leave the dev stack quiet: a re-sync would reactivate the nightly cron from the
    // definition, so pause it again for the next test/operator. Smoke re-syncs on demand.
    await request.post('/api/automations/sync', { data: { factory: FACTORY } });
    await request.post(`/api/automations/${FACTORY}/nightly/pause`, {
      data: { actor: 'e2e-cleanup', reason: 'e2e: leave the dev stack quiet' },
    });
  });
});

async function expectGate(
  page: import('@playwright/test').Page,
  workItemId: string,
  stage: string,
  timeout: number,
): Promise<void> {
  await expect
    .poll(
      async () => {
        try {
          await page.goto(`/work-items/${workItemId}`);
        } catch {
          return 'navigation-error';
        }
        const gate = page.getByTestId('gate-actions');
        if ((await gate.count()) === 0) return 'none';
        return (await gate.first().getAttribute('data-stage')) ?? 'unknown';
      },
      { timeout, intervals: [1_000] },
    )
    .toBe(stage);
}
