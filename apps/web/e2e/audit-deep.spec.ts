import { test, expect } from '@playwright/test';
import fs from 'node:fs';

/**
 * Deep UI audit: console/page errors plus render quality signals —
 * heading presence, body length, horizontal overflow, error-ish copy,
 * dead links. Writes /tmp/ui-audit-deep.json and screenshots.
 *
 *   cd apps/web && bunx playwright test audit-deep.spec.ts
 */

const API = process.env.API_BASE_URL ?? 'http://localhost:8080';
const OUT = '/tmp/ui-audit';
fs.mkdirSync(OUT, { recursive: true });

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

test('deep audit every page', async ({ page }) => {
  test.setTimeout(900_000);

  const runId = await firstId('/runs?limit=1', 'runs');
  const workItemId = await firstId('/work-items?limit=1', 'workItems');
  const scoreId = await firstId('/scores?limit=1', 'scores');

  const routes: string[] = [
    '/',
    '/chat',
    '/runs',
    '/inbox',
    '/work-items',
    '/secrets',
    '/mcps',
    '/users',
    '/help',
    '/help/quick-start',
    '/help/api',
    ...(runId ? [`/runs/${runId}`] : []),
    ...(workItemId ? [`/work-items/${workItemId}`] : []),
    ...(scoreId ? [`/scores/${scoreId}`] : []),
  ];
  const factoryPages = ['', '/dashboard', '/agents', '/automations', '/benchmarks', '/definition', '/gates', '/merge-queue', '/scorers', '/self-improvement', '/settings'];
  for (const factory of ['example', 'example-lights-off']) {
    for (const p of factoryPages) routes.push(`/factories/${factory}${p}`);
  }

  const report: Array<Record<string, unknown>> = [];

  for (const route of routes) {
    const consoleErrors: string[] = [];
    const consoleWarnings: string[] = [];
    const pageErrors: string[] = [];
    const badResponses: string[] = [];

    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text());
      else if (m.type() === 'warning') consoleWarnings.push(m.text());
    });
    page.on('pageerror', (e) => pageErrors.push(e.message));
    page.on('response', (r) => {
      if (r.status() >= 400) badResponses.push(`${r.status()} ${r.url()}`);
    });

    await page.goto(route, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForTimeout(1200);

    const metrics = await page.evaluate(() => {
      const body = document.body;
      const text = body.innerText || '';
      const h1 = document.querySelector('h1')?.textContent?.trim() ?? '';
      const h2s = Array.from(document.querySelectorAll('h2')).map((n) => n.textContent?.trim() ?? '');
      const scrollWidth = document.documentElement.scrollWidth;
      const clientWidth = document.documentElement.clientWidth;
      const deadLinks = Array.from(document.querySelectorAll('a[href]'))
        .map((a) => a.getAttribute('href') ?? '')
        .filter((h) => h === '#' || h.startsWith('javascript:') || h === '');
      return {
        textLength: text.trim().length,
        h1,
        h2s,
        overflowX: scrollWidth > clientWidth + 1 ? scrollWidth - clientWidth : 0,
        deadLinks: deadLinks.length,
        textSample: text.slice(0, 3000),
      };
    });

    const suspicious: string[] = [];
    for (const pattern of [/NaN/, /\bundefined\b/, /\[object Object\]/, /Internal Server Error/, /Application error/, /Something went wrong/i, /Failed to (load|fetch)/i, /Cannot read propert/i]) {
      if (pattern.test(metrics.textSample)) suspicious.push(String(pattern));
    }
    if (!metrics.h1) suspicious.push('no-h1');
    if (metrics.textLength < 40) suspicious.push(`thin-body:${metrics.textLength}`);
    if (metrics.overflowX > 0) suspicious.push(`overflow-x:${metrics.overflowX}px`);

    const slug = route.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'root';
    await page.screenshot({ path: `${OUT}/${slug}.png`, fullPage: false }).catch(() => {});

    report.push({ route, consoleErrors, consoleWarnings, pageErrors, badResponses, ...metrics, suspicious });

    page.removeAllListeners('console');
    page.removeAllListeners('pageerror');
    page.removeAllListeners('response');
  }

  fs.writeFileSync('/tmp/ui-audit-deep.json', JSON.stringify(report, null, 2));
  const problems = report.filter((r) => {
    const s = r.suspicious as string[];
    return s.length > 0 || (r.consoleErrors as string[]).length > 0 || (r.pageErrors as string[]).length > 0 || (r.badResponses as string[]).length > 0;
  });
  // eslint-disable-next-line no-console
  console.log(`DEEP AUDIT: ${report.length} routes, ${problems.length} with problems`);
  expect(report.length).toBeGreaterThan(0);
  // The audit is only useful if it fails: no overflow, console/page errors or bad responses.
  // Time-formatted pages render a deterministic ISO string first and format after mount, so
  // a React hydration mismatch (#418) is a defect again, not a tolerated flake.
  expect(
    problems.map((row) => ({
      route: row.route,
      suspicious: row.suspicious,
      consoleErrors: row.consoleErrors,
      pageErrors: row.pageErrors,
      badResponses: row.badResponses,
    })),
  ).toEqual([]);
});
