import { expect, test, type Page } from '@playwright/test';
import { cleanupRuns, cleanupWorkItems, factoryId, factoryPage, trackWorkItem } from './helpers';

/**
 * Phase 3a loop, lights-on: a manual work item runs triage → spec → implement → review
 * (two independent reviewers + judge) → verify → ship on the fake forge, with human gates
 * at triage/spec/ship. The review verdict is advisory and nothing merges before the ship
 * gate approves.
 */
test.describe('Factory loop (lights on)', () => {
  test.afterEach(async ({ request }) => {
    await cleanupWorkItems(request);
    await cleanupRuns(request);
  });

  test('manual item flows through every stage and merges only after the ship gate', async ({
    page,
  }) => {
    test.setTimeout(300_000);

    const exampleId = await factoryId(page.request, 'example');
    const boardPath = `/factories/${encodeURIComponent(exampleId)}/work-items`;

    // Board: all seven stage columns, in order, even when a factory has no agent for one.
    await page.goto(boardPath);
    const board = page.locator('[data-testid="work-items-board"]:visible').first();
    await expect(board).toBeVisible();
    const columns = await board.getByTestId('board-column').evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute('data-stage')),
    );
    expect(columns).toEqual(['triage', 'spec', 'plan', 'implement', 'review', 'verify', 'ship']);

    // The board is factory-scoped: every card belongs to this factory.
    const factories = await board.getByTestId('work-item-card').evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute('data-factory')),
    );
    for (const factory of factories) expect(factory).toBe('example');

    // Manual creation through the console (POST /factories/:id/work-items).
    await page.getByTestId('create-type').first().selectOption('task');
    await page.getByTestId('create-harness').first().selectOption('fake');
    const title = `e2e: factory loop ${Date.now()}`;
    await page.getByTestId('create-title').first().fill(title);
    await page.getByTestId('create-prompt').first().fill('fix the broken README link');
    await page.getByTestId('create-submit').first().click();

    await expect(page).toHaveURL(
      new RegExp(`/factories/${exampleId}/work-items/wi_[0-9A-HJKMNP-TV-Z]{26}$`),
      { timeout: 30_000 },
    );
    const workItemId = new URL(page.url()).pathname.split('/').pop() as string;
    const detailPath = `/factories/${encodeURIComponent(exampleId)}/work-items/${workItemId}`;
    trackWorkItem(exampleId, workItemId);

    await expect(page.getByTestId('work-item-detail').first()).toHaveAttribute(
      'data-work-item-id',
      workItemId,
    );
    await expect(page.getByTestId('work-item-title').first()).toHaveText(title);

    // The card is on the board, with its source, age and a link to the triage run.
    await page.goto(boardPath);
    const card = page.locator(`[data-testid="work-item-card"][data-work-item-id="${workItemId}"]`);
    await expect(card).toBeVisible({ timeout: 60_000 });
    await expect(card.getByTestId('work-item-card-status')).toHaveText('active');
    await expect(card.getByTestId('work-item-card-source')).toHaveText('manual');
    await expect(card.getByTestId('work-item-card-age')).toBeVisible();
    await expect(card.getByTestId('work-item-card-link')).toHaveAttribute(
      'href',
      detailPath,
    );
    await expect(card.getByTestId('work-item-card-run-link').first()).toBeVisible({
      timeout: 60_000,
    });

    // Gate 1: triage (human, aliased to the spec policy).
    await expectGate(page, detailPath, 'triage', 120_000);
    await expect(page.getByTestId('gate-actions').first()).toHaveAttribute('data-stage', 'triage');
    await expect(page.getByTestId('gate-sla').first()).toBeVisible();
    await page.getByTestId('gate-approve').first().click();

    // Gate 2: spec.
    await expectGate(page, detailPath, 'spec', 120_000);
    await page.getByTestId('gate-approve').first().click();

    // implement → review (2 reviewers) → verify are agent-gated; the next human gate is ship.
    await expectGate(page, detailPath, 'ship', 180_000);

    // Stage timeline: every transition names from → to, who and why.
    const transitions = page.locator('[data-testid="timeline-row"]:visible');
    expect(await transitions.count()).toBeGreaterThanOrEqual(5);
    const toStages = await transitions.evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute('data-to')),
    );
    for (const stage of ['spec', 'implement', 'review', 'verify', 'ship']) {
      expect(toStages).toContain(stage);
    }
    const first = transitions.first();
    await expect(first).toHaveAttribute('data-from', 'triage');
    await expect(first).toHaveAttribute('data-by', 'foreman');
    await expect(first.getByTestId('timeline-reason')).toContainText('foreman dispatch');

    // Review committee: two independent reviewers and an advisory judge verdict.
    const reports = page.locator('[data-testid="reviewer-report"]:visible');
    await expect.poll(() => reports.count(), { timeout: 30_000 }).toBeGreaterThanOrEqual(2);
    for (const report of await reports.all()) {
      await expect(report).toHaveAttribute('data-verdict', 'approve');
      await expect(report.getByTestId('reviewer-confidence').first()).toContainText('confidence');
    }
    const judge = page.getByTestId('review-judge').first();
    await expect(judge).toHaveAttribute('data-verdict', 'approve');
    await expect(judge).toHaveAttribute('data-advisory', 'true');
    await expect(judge).toHaveAttribute('data-confidence', /0\.\d+/);
    await expect(page.getByTestId('judge-advisory').first()).toContainText('advisory only');

    // Deterministic review packet: assembled from plan/evidence/diff before the ship gate.
    const packet = page.locator('[data-testid="work-item-review-packet"]:visible').first();
    await expect(packet).toBeVisible({ timeout: 30_000 });
    await expect(packet).toHaveAttribute('data-risk-tier', /^(low|medium|high)$/);
    await expect(page.getByTestId('review-packet-risk').first()).toContainText('risk');
    await expect(page.getByTestId('review-packet-intent').first()).toBeVisible();
    await expect(page.getByTestId('review-packet-diff').first()).toContainText('diff');
    // Review packet v2: slop status, budget vs actual, read-first and reviewer roles.
    await expect(page.getByTestId('review-packet-slop').first()).toBeVisible();
    await expect(page.getByTestId('review-packet-slop').first()).toHaveAttribute(
      'data-slop-status',
      /^(pass|exceeded|unknown)$/,
    );
    await expect(page.getByTestId('review-packet-budget').first()).toBeVisible();
    await expect(page.getByTestId('review-packet-read-first').first()).toBeVisible();
    await expect(page.getByTestId('review-packet-roles').first()).toBeVisible();
    // Proof is collected from the run's artifacts; if the fake harness produced none the
    // gallery is absent — assert the honest state instead of a fabricated artifact.
    const proof = page.getByTestId('review-packet-proof');
    if ((await proof.count()) > 0) {
      await expect(proof.first()).toBeVisible();
      await expect(page.getByTestId('review-packet-proof-link').first()).toBeVisible();
    } else {
      await expect(proof).toHaveCount(0);
    }

    // Forge: a PR exists and checks are green; nothing merged yet (ship gate still pending).
    await expect(page.getByTestId('work-item-pr').first()).toHaveAttribute('href', /^https:\/\/forge\.local\//);
    await expect(page.getByTestId('checks-green').first()).toHaveText('green');
    await expect(page.getByTestId('work-item-status').first()).toHaveText('active');
    await expect(page.getByTestId('work-item-not-merged').first()).toBeVisible();
    await expect(page.getByTestId('work-item-merged').first()).toHaveCount(0);
    await expect(page.locator('[data-testid="status-event"][data-reason*="merged"]')).toHaveCount(0);

    // Gate 3: ship. Only now may the loop merge.
    await expect(page.getByTestId('gate-actions').first()).toHaveAttribute('data-stage', 'ship');
    await page.getByTestId('gate-approve').first().click();

    await expect
      .poll(
        async () => {
          await page.goto(detailPath);
          return (await page.getByTestId('work-item-status').first().textContent())?.trim();
        },
        { timeout: 180_000, intervals: [1_000] },
      )
      .toBe('done');

    await expect(page.getByTestId('work-item-merged').first()).toBeVisible();
    await expect(page.getByTestId('work-item-merged').first()).toContainText('merged');
    await expect(
      page.locator('[data-testid="status-event"][data-reason*="merged"]').first(),
    ).toBeVisible();

    const shipRow = page
      .locator('[data-testid="gate-decision-row"]:visible')
      .filter({ hasText: 'ship' })
      .first();
    await expect(shipRow.getByTestId('gate-decision-decision')).toHaveAttribute(
      'data-decision',
      'approve',
    );
    await expect(shipRow.getByTestId('gate-decision-decision')).toHaveAttribute(
      'data-automatic',
      'false',
    );
    await expect(shipRow.getByTestId('gate-decision-actor')).toContainText('local-user');
    await expect(shipRow.getByTestId('gate-decision-time')).not.toHaveText('—');

    // Agent gates record the verdict that produced the automatic decision (change
    // `add-agent-verdicts`). The fake harness has no summary, so advisory `example` approves
    // with an explicit `unknown` / `none` verdict instead of an unexplained approval.
    const implementRow = page
      .locator('[data-testid="gate-decision-row"]:visible')
      .filter({ hasText: 'implement' })
      .first();
    await expect(implementRow.getByTestId('gate-verdict')).toHaveAttribute('data-decision', 'unknown');
    await expect(implementRow.getByTestId('gate-verdict')).toHaveAttribute('data-source', 'none');
    await expect(implementRow.getByTestId('gate-decision-decision')).toHaveAttribute(
      'data-decision',
      'approve',
    );
    await expect(implementRow.getByTestId('gate-decision-decision')).toHaveAttribute(
      'data-automatic',
      'true',
    );
  });
});

/** Reloads the detail page until the pending gate is `stage` (or fails the expectation). */
async function expectGate(page: Page, detailPath: string, stage: string, timeout: number): Promise<void> {
  await expect
    .poll(
      async () => {
        try {
          await page.goto(detailPath);
        } catch {
          return 'navigation-error';
        }
        const gate = page.getByTestId('gate-actions').first();
        if ((await gate.count()) === 0) return 'none';
        return (await gate.first().getAttribute('data-stage')) ?? 'unknown';
      },
      { timeout, intervals: [1_000] },
    )
    .toBe(stage);
}
