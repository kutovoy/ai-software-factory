import { expect, test } from '@playwright/test';
import { randomInt } from 'node:crypto';
import { factoryId, factoryPage } from './helpers';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** A fresh Crockford base32 ULID body; mission plan ids must not collide across runs. */
function ulid(prefix: string): string {
  let out = prefix;
  for (let index = 0; index < 26; index += 1) {
    out += CROCKFORD[randomInt(CROCKFORD.length)];
  }
  return out;
}

/**
 * Mission Control smoke: create a mission through the API with a supplied plan (so the
 * planner/model is not needed), open its detail, see the contract/features/controls, then
 * cancel it. The list must project the same mission.
 */
test('mission list and detail render the plan, features and lifecycle controls', async ({
  page,
  request,
}) => {
  const id = await factoryId(request, 'hello-nextjs');
  const milestoneId = ulid('mst_');
  const featureId = ulid('mft_');
  const planMissionId = ulid('mis_');
  const plan = {
    version: 'v1alpha1',
    missionId: planMissionId,
    factory: 'hello-nextjs',
    definitionCommit: '0000000',
    title: 'E2E docs mission',
    goal: 'Add a Docs page at /docs',
    createdAt: new Date().toISOString(),
    validationContract: {
      version: 'v1alpha1',
      missionId: planMissionId,
      factory: 'hello-nextjs',
      definitionCommit: '0000000',
      createdAt: new Date().toISOString(),
      enforce: true,
      assertions: [
        {
          id: 'docs-route-renders',
          title: 'Docs route renders',
          assertion: 'GET /docs returns HTTP 200 and renders a visible Docs heading.',
          tier: 'e2e',
          required: true,
          tool: 'Playwright',
          evidence: 'Playwright report',
          expected: 'test passes',
        },
      ],
      risks: [],
      source: 'human',
    },
    milestones: [
      {
        id: milestoneId,
        title: 'Docs page',
        description: 'Add the docs route',
        order: 0,
        features: [
          {
            id: featureId,
            title: 'Add Docs page at /docs',
            description: 'Create app/docs/page.tsx with a visible Docs heading.',
            order: 0,
            dependsOn: [],
            acceptanceCheckIds: ['docs-route-renders'],
            workItemType: 'task',
          },
        ],
      },
    ],
    risks: [],
    assumptions: [],
  };

  const created = await request.post(`/api/v1/factories/${encodeURIComponent(id)}/missions`, {
    data: {
      title: 'E2E docs mission',
      goal: 'Add a Docs page at /docs',
      budget: { maxRuns: 4 },
      plan,
    },
  });
  expect(created.ok(), `POST missions failed: ${created.status()} ${await created.text()}`).toBeTruthy();
  const body = (await created.json()) as { mission: { id: string } };
  const missionId = body.mission.id;

  await page.goto(
    `/factories/${encodeURIComponent(id)}/missions/${encodeURIComponent(missionId)}`,
  );
  await expect(page.getByTestId('mission-plan-card')).toBeVisible();
  await expect(page.getByTestId('mission-contract-assertions')).toBeVisible();
  await expect(page.getByTestId('mission-feature').first()).toBeVisible();
  await expect(page.getByTestId('mission-controls')).toBeVisible();

  await page.getByTestId('mission-cancel-open').click();
  await page.getByTestId('mission-control-reason').fill('e2e cleanup');
  await page.getByTestId('mission-cancel-submit').click();
  await expect(page.getByTestId('mission-status')).toHaveText('cancelled', { timeout: 30_000 });

  await page.goto(await factoryPage(request, 'hello-nextjs', 'missions'));
  await expect(page.getByTestId('missions-count')).toBeVisible();
  await expect(page.getByText('E2E docs mission').first()).toBeVisible();
});
