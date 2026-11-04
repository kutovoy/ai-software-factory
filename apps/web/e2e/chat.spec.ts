import { expect, test } from '@playwright/test';
import { cleanupRuns, factoryId, factoryPage, trackRun } from './helpers';

test.afterEach(async ({ request }) => {
  await cleanupRuns(request);
});

/** The core loop: prompt → tool call visible → approve permission → terminal state. */
test.describe('New Chat streams a run', () => {
  test('prompt → tool call → permission → terminal', async ({ page }) => {
    // /chat selects the persisted factory cookie, or the first factory the viewer owns.
    // Pin `example` so the run and the later factory-scoped run detail agree.
    const exampleId = await factoryId(page.request, 'example');
    await page.context().addCookies([{ name: 'factory', value: exampleId, url: 'http://localhost:3000' }]);
    await page.goto('/chat');

    await expect(page.getByTestId('nav-sidebar')).toBeVisible();
    await page.getByTestId('chat-harness').selectOption('fake');
    await page.getByTestId('chat-prompt').fill('e2e: read the README and list the directory');
    await page.getByTestId('chat-submit').click();

    const header = page.getByTestId('run-header');
    await expect(header).toBeVisible({ timeout: 30_000 });

    const runId = await page.getByTestId('run-link').getAttribute('data-run-id');
    expect(runId, 'the run header must expose the created run id').toBeTruthy();
    trackRun(await factoryId(page.request, 'example'), runId);

    // Tool calls render with name, arguments and result status.
    const toolCall = page.getByTestId('tool-call').first();
    await expect(toolCall).toBeVisible({ timeout: 60_000 });
    await expect(toolCall).toHaveAttribute('data-tool-name', 'read_file');
    await expect(page.getByTestId('tool-call-args').first()).toContainText('README.md');
    await expect(toolCall).toHaveAttribute('data-ok', 'true');

    // A permission prompt arrives inline and is actionable.
    const permission = page.getByTestId('permission-prompt');
    await expect(permission).toBeVisible({ timeout: 60_000 });
    await expect(permission).toHaveAttribute('data-status', 'pending');
    await page.getByTestId('permission-allow').click();
    await expect(page.getByTestId('permission-status')).toHaveText('allowed');

    // The run reaches a terminal state, shown in the header.
    await expect(page.getByTestId('run-terminal')).toHaveAttribute('data-status', 'ok', {
      timeout: 60_000,
    });
    await expect(page.getByTestId('run-status')).toHaveText('ok');

    // Usage chip + diff block are rendered by the same stream.
    await expect(page.getByTestId('usage-chip')).toBeVisible();
    await expect(page.getByTestId('file-edited')).toBeVisible();
    await expect(page.getByTestId('file-diff')).toContainText('@@');

    // Run detail never leaks the provider credential.
    await page.goto(await factoryPage(page.request, 'example', `runs/${runId}`));
    await expect(page.getByTestId('pinned-commit')).toBeVisible();
    await expect(page.getByTestId('run-terminal')).toBeVisible({ timeout: 60_000 });

    const html = await page.content();
    expect(html).not.toContain('sk-provider-secret');
    expect(html).not.toContain('OPENAI_API_KEY=');
  });

  test('denying a permission resolves the prompt inline', async ({ page }) => {
    await page.goto('/chat');
    await page.getByTestId('chat-harness').selectOption('fake');
    await page.getByTestId('chat-prompt').fill('e2e: deny path');
    await page.getByTestId('chat-submit').click();

    await expect(page.getByTestId('run-header')).toBeVisible({ timeout: 30_000 });
    trackRun(
      await factoryId(page.request, 'example'),
      await page.getByTestId('run-link').getAttribute('data-run-id'),
    );

    await expect(page.getByTestId('permission-prompt')).toBeVisible({ timeout: 60_000 });
    await page.getByTestId('permission-deny').click();
    await expect(page.getByTestId('permission-status')).toHaveText('denied');
    await expect(page.getByTestId('permission-outcome')).toBeVisible();
    await expect(page.getByTestId('run-terminal')).toHaveAttribute('data-status', 'ok', {
      timeout: 60_000,
    });
  });
});

/** Guard against console noise while streaming (hydration mismatches, failed fetches). */
test('streaming produces no console errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(String(error)));

  await page.goto('/chat');
  await page.getByTestId('chat-harness').selectOption('fake');
  await page.getByTestId('chat-prompt').fill('e2e: console cleanliness');
  await page.getByTestId('chat-submit').click();

  await expect(page.getByTestId('run-header')).toBeVisible({ timeout: 30_000 });
  trackRun(
    await factoryId(page.request, 'example'),
    await page.getByTestId('run-link').getAttribute('data-run-id'),
  );

  await expect(page.getByTestId('permission-prompt')).toBeVisible({ timeout: 60_000 });
  await page.getByTestId('permission-allow').click();
  await expect(page.getByTestId('run-terminal')).toBeVisible({ timeout: 60_000 });

  const relevant = errors.filter((line) => !line.includes('favicon'));
  expect(relevant, `console errors: ${relevant.join('\n')}`).toHaveLength(0);
});
