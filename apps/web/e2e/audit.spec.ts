import { test, expect } from '@playwright/test';
import fs from 'node:fs';

/**
 * UI audit: walks every page, records console errors/warnings, uncaught exceptions,
 * failed requests, error responses and suspicious rendered text. Writes a JSON report.
 *
 *   cd apps/web && bunx playwright test audit.spec.ts
 *
 * Not part of the CI suite (no assertions on product behaviour).
 */

const API = process.env.API_BASE_URL ?? 'http://localhost:8080';

type Finding = {
  route: string;
  consoleErrors: string[];
  consoleWarnings: string[];
  pageErrors: string[];
  failedRequests: string[];
  badResponses: string[];
  suspiciousText: string[];
  title: string;
};

async function firstFactoryId(key: string): Promise<string | null> {
  try {
    const res = await fetch(`${API}/api/v1/factories`);
    if (!res.ok) return null;
    const json = (await res.json()) as { factories?: Array<{ id: string | null; name: string; key: string }> };
    const hit = (json.factories ?? []).find((row) => row.name === key || row.key === key);
    return hit?.id ?? null;
  } catch {
    return null;
  }
}

async function firstId(path: string, key: string): Promise<string | null> {
  try {
    const res = await fetch(`${API}/api/v1${path}`);
    if (!res.ok) return null;
    const json = (await res.json()) as Record<string, unknown>;
    const list = json[key] as Array<Record<string, unknown>> | undefined;
    return (list?.[0]?.id as string) ?? null;
  } catch {
    return null;
  }
}

test('audit every page', async ({ page }) => {
  test.setTimeout(600_000);

  const exampleId = await firstFactoryId('example');
  const lightsOffId = await firstFactoryId('example-lights-off');
  const runId = exampleId
    ? await firstId(`/factories/${exampleId}/runs?limit=1`, 'runs')
    : null;
  const workItemId = exampleId
    ? await firstId(`/factories/${exampleId}/work-items?limit=1`, 'workItems')
    : null;
  const scoreId = await firstId('/scores?limit=1', 'scores');

  const factories = [exampleId, lightsOffId].filter((id): id is string => Boolean(id));
  const routes: string[] = [
    '/',
    '/chat',
    '/inbox',
    '/secrets',
    '/mcps',
    '/users',
    '/help',
    '/help/api',
    ...(runId && exampleId ? [`/factories/${exampleId}/runs/${runId}`] : []),
    ...(workItemId && exampleId ? [`/factories/${exampleId}/work-items/${workItemId}`] : []),
    ...(scoreId ? [`/scores/${scoreId}`] : []),
  ];

  const factoryPages = [
    '',
    '/dashboard',
    '/agents',
    '/automations',
    '/benchmarks',
    '/definition',
    '/gates',
    '/merge-queue',
    '/scorers',
    '/self-improvement',
    '/settings',
  ];
  for (const factory of factories) {
    for (const p of factoryPages) routes.push(`/factories/${factory}${p}`);
  }

  const findings: Finding[] = [];

  for (const route of routes) {
    const consoleErrors: string[] = [];
    const consoleWarnings: string[] = [];
    const pageErrors: string[] = [];
    const failedRequests: string[] = [];
    const badResponses: string[] = [];

    const onConsole = (msg: { type: () => string; text: () => string }) => {
      const type = msg.type();
      const text = msg.text();
      if (type === 'error') consoleErrors.push(text);
      else if (type === 'warning') consoleWarnings.push(text);
    };
    const onPageError = (err: Error) => pageErrors.push(`${err.name}: ${err.message}`);
    const onRequestFailed = (req: { url: () => string; failure: () => { errorText?: string } | null }) => {
      const url = req.url();
      const failure = req.failure()?.errorText ?? 'unknown';
      // Navigation aborts are noise (redirects); keep everything else.
      if (failure.includes('ERR_ABORTED')) return;
      failedRequests.push(`${url} (${failure})`);
    };
    const onResponse = (res: { url: () => string; status: () => number }) => {
      const status = res.status();
      if (status >= 400) badResponses.push(`${status} ${res.url()}`);
    };

    page.on('console', onConsole);
    page.on('pageerror', onPageError);
    page.on('requestfailed', onRequestFailed);
    page.on('response', onResponse);

    let title = '';
    try {
      await page.goto(route, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await page.waitForTimeout(1500);
      title = await page.title();
    } catch (err) {
      pageErrors.push(`navigation: ${(err as Error).message}`);
    }

    const bodyText = await page.locator('body').innerText().catch(() => '');
    const suspiciousText: string[] = [];
    for (const pattern of [/NaN/, /undefined/, /\[object Object\]/, /Internal Server Error/, /Application error/, /Something went wrong/i]) {
      if (pattern.test(bodyText)) suspiciousText.push(`matched ${pattern}`);
    }

    page.off('console', onConsole);
    page.off('pageerror', onPageError);
    page.off('requestfailed', onRequestFailed);
    page.off('response', onResponse);

    findings.push({ route, consoleErrors, consoleWarnings, pageErrors, failedRequests, badResponses, suspiciousText, title });
  }

  fs.writeFileSync('/tmp/ui-audit.json', JSON.stringify(findings, null, 2));
  const problems = findings.filter(
    (f) => f.consoleErrors.length || f.pageErrors.length || f.failedRequests.length || f.badResponses.length || f.suspiciousText.length,
  );
  // eslint-disable-next-line no-console
  console.log(`AUDIT: ${findings.length} routes, ${problems.length} with problems`);
  expect(findings.length).toBeGreaterThan(0);
});
