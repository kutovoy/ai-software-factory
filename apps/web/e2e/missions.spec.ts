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
    riskTier: 'medium',
    riskReasons: ['Adds a new public route', 'Touches shared navigation'],
    planDepth: 'full',
    expectedPain: 'medium',
    leverage: 'Add one static route and link it from the navigation',
    productReview: {
      problem: 'Operators cannot find setup documentation from inside the app.',
      desiredBehavior: [
        'GET /docs renders a visible Docs heading',
        'The Docs link appears in the navigation',
      ],
      mockups: ['docs-page.png'],
      visualArtifacts: ['docs-page.png', 'docs-navigation-diagram.svg'],
    },
    architecture: {
      summary: 'A single static docs route inside the existing Next.js app.',
      components: [
        {
          name: 'DocsPage',
          responsibility: 'Render the docs route',
          contracts: ['GET /docs returns HTTP 200'],
        },
      ],
      dataModels: ['none'],
      constraints: ['No new runtime dependency'],
    },
    programDesign: {
      modules: [
        {
          name: 'DocsPage',
          path: 'app/docs/page.tsx',
          responsibility: 'Static docs route',
          publicApi: ['default DocsPage()'],
        },
      ],
      callGraph: ['app/docs/page.tsx -> components/ui/Card'],
    },
    verticalSlices: [
      {
        name: 'Docs page renders end to end',
        order: 0,
        featureIds: [featureId],
        checks: ['docs-route-renders'],
      },
    ],
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
        {
          id: 'docs-route-layering',
          title: 'Docs route respects layering',
          assertion: 'The docs page imports only the shared UI layer.',
          tier: 'architecture',
          required: true,
          tool: 'command',
          evidence: 'exit code 0',
          command: 'bun run lint:boundaries',
          expected: 'exit code 0',
          thresholds: { maxDependencyCycles: 0 },
        },
        {
          id: 'docs-diff-size',
          title: 'Docs change stays small',
          assertion: 'The docs change stays under the diff-size budget.',
          tier: 'maintainability',
          required: true,
          tool: 'command',
          evidence: 'diff stat',
          command: 'git diff --stat',
          expected: 'under 400 changed lines',
          thresholds: { maxChangedLines: 400 },
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
            acceptanceCheckIds: ['docs-route-renders', 'docs-route-layering', 'docs-diff-size'],
            workItemType: 'task',
            riskTier: 'medium',
            verticalSlice: 'Docs page renders end to end',
            kind: 'slice',
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
  await expect(page.getByTestId('mission-plan-card').first()).toBeVisible();
  await expect(page.getByTestId('mission-plan-risk').first()).toHaveText('medium risk');
  await expect(page.getByTestId('mission-plan-risk-reasons').first()).toBeVisible();
  await expect(page.getByTestId('mission-plan-depth').first()).toContainText('full');
  await expect(page.getByTestId('mission-plan-pain').first()).toContainText('medium');
  await expect(page.getByTestId('mission-plan-leverage').first()).toContainText('static route');
  await expect(page.getByTestId('mission-plan-product-review').first()).toBeVisible();
  await expect(page.getByTestId('mission-plan-visual-artifacts').first()).toBeVisible();
  await expect(page.getByTestId('mission-plan-visual-artifact').first()).toContainText('docs-page.png');
  await expect(page.getByTestId('mission-plan-architecture').first()).toBeVisible();
  await expect(page.getByTestId('mission-plan-program-design').first()).toBeVisible();
  await expect(page.getByTestId('mission-plan-vertical-slices').first()).toBeVisible();
  await expect(page.getByTestId('mission-contract-assertions').first()).toBeVisible();
  await expect(page.getByTestId('mission-feature').first()).toBeVisible();
  await expect(page.getByTestId('mission-controls').first()).toBeVisible();

  await page.getByTestId('mission-cancel-open').first().click();
  await page.getByTestId('mission-control-reason').first().fill('e2e cleanup');
  await page.getByTestId('mission-cancel-submit').first().click();
  await expect(page.getByTestId('mission-status').first()).toHaveText('cancelled', { timeout: 30_000 });

  await page.goto(await factoryPage(request, 'hello-nextjs', 'missions'));
  await expect(page.getByTestId('missions-count').first()).toBeVisible();
  await expect(page.getByText('E2E docs mission').first()).toBeVisible();
});
