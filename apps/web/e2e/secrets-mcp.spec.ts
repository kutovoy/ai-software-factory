import { expect, test } from '@playwright/test';

/**
 * Secrets + MCPs (change `add-secrets-and-mcp`).
 *
 * Runs against the compose stack. No credentials and no network: the secret is a name that
 * does not resolve (so the UI must say so), and the MCP probe spawns a command that is not
 * installed in the runner — a real, deterministic `unhealthy` result.
 */

const FACTORY = 'example';
const createdSecrets: string[] = [];

test.describe('secrets and MCPs', () => {
  test.afterEach(async ({ request }) => {
    for (const name of createdSecrets.splice(0)) {
      await request.delete(`/api/secrets/${encodeURIComponent(name)}`).catch(() => undefined);
    }
  });

  test('register a secret name, see its presence, then delete it', async ({ page, request }) => {
    test.setTimeout(120_000);
    const name = `E2E_SECRET_${Date.now()}`;

    await page.goto('/secrets');
    await expect(page.getByTestId('secrets-registry')).toBeVisible();

    if ((await page.getByTestId('secret-create-form').count()) === 0) {
      await page.getByTestId('secret-create-toggle').click();
    }
    await page.getByTestId('secret-create-name').fill(name);
    await page.getByTestId('secret-create-description').fill('e2e: registry round-trip');
    await page.getByTestId('secret-create-submit').click();

    const row = page.locator(`[data-testid="secret-row"]`).filter({ hasText: name });
    await expect(row).toBeVisible({ timeout: 30_000 });
    createdSecrets.push(name);

    // The value is absent from the environment: the registry must say so, not pretend.
    await expect(row.getByTestId('secret-status')).toHaveText('unresolved');
    await expect(row.getByTestId('secret-last-used')).toContainText('never used');
    await expect(page.getByTestId('secret-form-notice')).toContainText('does not resolve');

    // Deleting an unused, unreferenced name succeeds.
    await row.locator('[data-testid="secret-delete"]').click();
    await expect(row).toHaveCount(0, { timeout: 30_000 });

    const listed = await request.get('/api/secrets');
    const body = (await listed.json()) as { secrets: { name: string }[] };
    expect(body.secrets.some((secret) => secret.name === name)).toBe(false);
  });

  test('an in-use secret is refused with an explanation', async ({ page }) => {
    test.setTimeout(120_000);

    await page.goto('/secrets');
    if ((await page.getByTestId('secret-create-form').count()) === 0) {
      await page.getByTestId('secret-create-toggle').click();
    }
    // `GITHUB_TOKEN` is referenced by factories/example's MCP server declaration.
    await page.getByTestId('secret-create-name').fill('GITHUB_TOKEN');
    await page.getByTestId('secret-create-submit').click();
    await expect(page.getByTestId('secret-form-notice')).toBeVisible({ timeout: 30_000 });

    const row = page.locator('[data-testid="secret-row"]').filter({ hasText: 'GITHUB_TOKEN' });
    await expect(row).toBeVisible();
    await row.locator('[data-testid="secret-delete"]').click();
    await expect(page.getByTestId('secret-form-error')).toContainText('secret_in_use');
    await expect(page.getByTestId('secret-form-error')).toContainText('mcp:github');
    await expect(row).toBeVisible();
  });

  test('register and test a declared MCP server, then see the agent binding', async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);

    await page.goto(`/mcps?factory=${FACTORY}`);
    await expect(page.getByTestId('mcp-registry')).toBeVisible();

    const rows = page.getByTestId('mcp-server-row');
    if ((await rows.count()) === 0) {
      await page.getByTestId('mcp-add-toggle').click();
      await page.getByTestId('mcp-add-select').selectOption('github');
      await page.getByTestId('mcp-add-submit').click();
      await expect(page.getByTestId('mcp-form-notice')).toContainText('Registered github', {
        timeout: 30_000,
      });
    }

    const github = page.locator('[data-testid="mcp-server-row"]').filter({ hasText: 'github' });
    await expect(github).toBeVisible({ timeout: 30_000 });
    await expect(github.getByTestId('mcp-server-transport')).toContainText('stdio');
    await expect(github.getByTestId('mcp-server-secrets')).toContainText('GITHUB_TOKEN=GITHUB_TOKEN');

    await github.locator('[data-testid="mcp-test-button"]').click();
    // The probe runs in the worker; `github-mcp` is not installed, so it fails honestly.
    await expect(github.getByTestId('mcp-test-result')).toContainText(/failed|reachable/, {
      timeout: 120_000,
    });
    await expect(github.getByTestId('mcp-test-result')).toContainText('ran in worker');
    await expect(github.getByTestId('mcp-server-status')).toHaveText('unhealthy');

    // The agent binding is visible on the factory Agents page.
    await page.goto(`/factories/${FACTORY}/agents`);
    const implement = page.locator('[data-testid="agent-card"][data-agent="implement"]');
    await expect(implement).toBeVisible();
    await expect(implement.getByTestId('agent-mcp-servers')).toContainText('github');
    await expect(implement.getByTestId('agent-mcp-allow')).toContainText('github*');

    const review = page.locator('[data-testid="agent-card"][data-agent="review"]');
    await expect(review.getByTestId('agent-mcp-servers')).toContainText('no MCP servers');
    await expect(review.getByTestId('agent-mcp-deny')).toContainText('github*');

    // The API projection agrees with the UI.
    const projection = await request.get(`/api/factories/${FACTORY}/mcp`);
    expect(projection.ok()).toBeTruthy();
    const body = (await projection.json()) as {
      servers: { name: string; status: string; env: Record<string, string> }[];
      agents: { agent: string; servers: string[]; deny: string[] }[];
    };
    const server = body.servers.find((entry) => entry.name === 'github');
    expect(server?.env).toEqual({ GITHUB_TOKEN: 'GITHUB_TOKEN' });
    expect(body.agents.find((entry) => entry.agent === 'implement')?.servers).toEqual(['github']);
    expect(body.agents.find((entry) => entry.agent === 'review')?.deny).toEqual(['github*']);
  });
});
