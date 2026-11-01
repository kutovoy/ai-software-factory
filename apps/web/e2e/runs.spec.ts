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
    // The cell shows the 12-char short SHA; the full 40-char value is in `title` (and the
    // copy affordance), so a long commit cannot widen the metadata cell.
    await expect(pinned).toContainText(run.definitionCommit.slice(0, 12));
    await expect(pinned).toHaveAttribute('title', run.definitionCommit);
    await expect(page.getByTestId('pinned-commit-copy')).toBeVisible();
    await expect(page.getByTestId('run-harness')).toHaveText('fake');
    await expect(page.getByTestId('run-model')).toBeVisible();
    await expect(page.getByTestId('run-steps')).toBeVisible();
    await expect(page.getByTestId('run-artifacts-card')).toBeVisible();

    // A blocked run exposes the inline prompt; approve it so the workflow can finish.
    await resolvePermissionIfBlocked(page);
    await expect(page.getByTestId('run-terminal')).toBeVisible({ timeout: 60_000 });

    // A healthy run renders no failure panel (spec `run-lifecycle` › Healthy run).
    await expect(page.getByTestId('run-failure-panel')).toHaveCount(0);
  });

  test('metadata cells do not overlap at 1280px or narrower', async ({ page, request }) => {
    const run = await createFakeRun(request, { prompt: 'e2e: meta layout' });
    await page.goto(`/runs/${run.id}`);
    await expect(page.getByTestId('run-meta')).toBeVisible();

    /** Groups cells by row and asserts each one ends before the next begins. */
    const assertNoOverlap = async (width: number): Promise<void> => {
      await page.setViewportSize({ width, height: 900 });
      const cells = await page.getByTestId('run-meta-cell').evaluateAll((nodes) =>
        nodes.map((node) => {
          const box = node.getBoundingClientRect();
          return {
            meta: node.getAttribute('data-meta'),
            left: box.left,
            right: box.right,
            top: Math.round(box.top),
            scrollWidth: node.scrollWidth,
            clientWidth: node.clientWidth,
          };
        }),
      );

      expect(cells.length).toBe(8);

      const rows = new Map<number, typeof cells>();
      for (const cell of cells) rows.set(cell.top, [...(rows.get(cell.top) ?? []), cell]);
      for (const row of rows.values()) {
        const sorted = [...row].sort((a, b) => a.left - b.left);
        for (let index = 1; index < sorted.length; index += 1) {
          const previous = sorted[index - 1]!;
          const current = sorted[index]!;
          expect(
            previous.right,
            `cells overlap at ${width}px: ${previous.meta} ends at ${previous.right}, ${current.meta} starts at ${current.left}`,
          ).toBeLessThanOrEqual(current.left + 0.5);
        }
      }

      // A cell must clip (not spill) its content, and the page must not scroll sideways.
      for (const cell of cells) {
        expect(cell.scrollWidth, `cell ${cell.meta} overflows at ${width}px`).toBeLessThanOrEqual(
          cell.clientWidth + 1,
        );
      }
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `horizontal overflow at ${width}px`).toBeLessThanOrEqual(1);
    };

    await assertNoOverlap(1280);
    await assertNoOverlap(900);
    await assertNoOverlap(600);
  });

  test('failed run shows the failure panel with workflow id and Temporal link', async ({
    page,
  }) => {
    // The panel is proven on a real failed run: the console keeps runs, so the newest
    // `error` run in this environment is the one an operator would open. A clean database
    // has none, in which case the cancelled case below still covers the panel.
    const api = process.env.API_BASE_URL ?? 'http://localhost:8080';
    const response = await page.request.get(`${api}/api/v1/runs?status=error&limit=5`);
    expect(response.ok()).toBeTruthy();
    const body = (await response.json()) as { runs: Array<{ id: string }> };
    const failed = body.runs[0];
    test.skip(!failed, 'no failed run in this environment');

    await page.goto(`/runs/${failed!.id}`);

    const panel = page.getByTestId('run-failure-panel');
    await expect(panel).toBeVisible();
    await expect(page.getByTestId('run-failure-status')).toHaveText('error');
    await expect(page.getByTestId('run-failure-message')).not.toBeEmpty();
    await expect(page.getByTestId('run-failure-workflow-id')).toContainText(/run/);

    const link = page.getByTestId('run-failure-temporal-link');
    await expect(link).toBeVisible();
    const href = await link.getAttribute('href');
    expect(href).toMatch(
      /^https?:\/\/[^/]+\/namespaces\/[^/]+\/workflows\/.+/,
    );
    expect(await page.getByTestId('run-failure-hint').textContent()).toBeTruthy();
  });

  test('cancelled run shows the reason and actor in the failure panel', async ({
    page,
    request,
  }) => {
    const run = await createFakeRun(request, {
      prompt: 'e2e: cancelled panel',
      fakeDelayMs: 3000,
    });
    const cancelled = await request.post(`/api/runs/${run.id}/cancel`, {
      data: { reason: 'e2e cancelled panel' },
    });
    expect(cancelled.ok()).toBeTruthy();

    await page.goto(`/runs/${run.id}`);

    const panel = page.getByTestId('run-failure-panel');
    await expect(panel).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('run-failure-status')).toHaveText('cancelled');
    await expect(page.getByTestId('run-cancel-reason')).toContainText('e2e cancelled panel');
    await expect(page.getByTestId('run-cancel-actor')).not.toBeEmpty();
    await expect(page.getByTestId('run-failure-workflow-id')).toContainText(/run/);
    await expect(page.getByTestId('run-failure-temporal-link')).toBeVisible();
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
