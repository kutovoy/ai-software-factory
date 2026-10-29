import { expect, test, type Page } from '@playwright/test';
import { cleanupRuns, createFakeRun } from './helpers';

test.afterEach(async ({ request }) => {
  await cleanupRuns(request);
});

/**
 * A fake-harness run blocks on an interactive permission. Approve it if (and when) it
 * appears, so the workflow can reach a terminal state; otherwise the run is already done.
 */
async function resolvePermissionIfBlocked(page: Page): Promise<void> {
  const allow = page.getByTestId('permission-allow');
  const terminal = page.getByTestId('run-terminal');
  await expect(allow.or(terminal).first()).toBeVisible({ timeout: 60_000 });
  if (await allow.isVisible()) await allow.click();
}

/** Runs list → detail (pinned commit) → replay after a mid-stream reload. */
test.describe('Runs', () => {
  test('list renders newest-first with filters and status', async ({ page }) => {
    await page.goto('/runs');

    await expect(page.getByTestId('runs-filters')).toBeVisible();
    await expect(page.getByTestId('runs-filter-factory')).toBeVisible();
    await expect(page.getByTestId('runs-filter-status')).toBeVisible();

    const table = page.getByTestId('runs-table');
    const empty = page.getByTestId('runs-empty');
    await expect(table.or(empty)).toBeVisible();

    if ((await table.count()) > 0) {
      const rows = page.getByTestId('run-row');
      expect(await rows.count()).toBeGreaterThan(0);

      const first = rows.first();
      await expect(first.getByTestId('run-row-status')).toBeVisible();
      await expect(first.getByTestId('run-row-commit')).toContainText(/[0-9a-f]{8}/);
      await expect(first.getByTestId('run-row-cost')).toBeVisible();

      // Newest first: assert on the server-provided `startedAt`, not on id format —
      // integration fixtures create runs whose ids do not embed a timestamp.
      const started = await page.getByTestId('run-row-link').evaluateAll((nodes) =>
        nodes.slice(0, 5).map((node) => Date.parse(node.getAttribute('data-started-at') ?? '')),
      );
      for (let index = 1; index < started.length; index += 1) {
        expect(started[index - 1]!).toBeGreaterThanOrEqual(started[index]!);
      }

      // Filtering by status narrows the list server-side.
      await page.getByTestId('runs-filter-status').selectOption('ok');
      await page.getByTestId('runs-filter-submit').click();
      await expect(page).toHaveURL(/status=ok/);
      await expect(page.getByTestId('runs-table').or(page.getByTestId('runs-empty'))).toBeVisible();
    }
  });

  test('detail shows the pinned commit, harness and model', async ({ page, request }) => {
    const run = await createFakeRun(request, { prompt: 'e2e: run detail' });

    await page.goto(`/runs/${run.id}`);

    const pinned = page.getByTestId('pinned-commit');
    await expect(pinned).toBeVisible();
    await expect(pinned).toContainText(run.definitionCommit);
    await expect(page.getByTestId('run-harness')).toHaveText('fake');
    await expect(page.getByTestId('run-model')).toBeVisible();
    await expect(page.getByTestId('run-steps')).toBeVisible();
    await expect(page.getByTestId('run-artifacts-card')).toBeVisible();

    // A blocked run exposes the inline prompt; approve it so the workflow can finish.
    await resolvePermissionIfBlocked(page);
    await expect(page.getByTestId('run-terminal')).toBeVisible({ timeout: 60_000 });
  });

  test('reload mid-stream replays without duplicates', async ({ page, request }) => {
    const run = await createFakeRun(request, { prompt: 'e2e: replay', fakeDelayMs: 400 });

    await page.goto(`/runs/${run.id}`);
    const stream = page.getByTestId('event-stream');
    await expect(stream).toBeVisible();

    const eventNodes = stream.locator('[data-seq]');
    await expect.poll(async () => eventNodes.count(), { timeout: 60_000 }).toBeGreaterThan(2);

    await page.reload();
    await expect(page.getByTestId('event-stream')).toBeVisible();

    await resolvePermissionIfBlocked(page);
    await expect(page.getByTestId('run-terminal')).toBeVisible({ timeout: 60_000 });

    const seqs = await page
      .locator('[data-testid="event-stream"] [data-seq]')
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-seq')));

    expect(seqs.length).toBeGreaterThan(0);
    expect(new Set(seqs).size, `duplicate seqs: ${seqs.join(',')}`).toBe(seqs.length);

    // The stream resumed from the last seen seq, never restarted from 0.
    const lastSeq = await page.getByTestId('run-last-seq').textContent();
    expect(Number((lastSeq ?? '').replace(/\D+/g, ''))).toBeGreaterThan(0);
  });
});
