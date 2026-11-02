import { expect, type APIRequestContext } from '@playwright/test';

/**
 * Every E2E-created run is tracked and cancelled in `afterEach`. A fake-harness run that
 * is left blocked on a permission holds one of the worker's 8 activity slots for up to
 * 30 minutes — enough abandoned runs would starve the queue and make the suite flaky.
 */
const created: Array<{ factoryId: string; runId: string }> = [];
const createdWorkItems: Array<{ factoryId: string; workItemId: string }> = [];

/** Factory ids by definition key, cached per worker (change `add-factory-identity`). */
const factoryIds = new Map<string, string>();

export function trackRun(factoryId: string, runId: string | null | undefined): void {
  if (!runId) return;
  if (created.some((entry) => entry.runId === runId)) return;
  created.push({ factoryId, runId });
}

export function trackWorkItem(factoryId: string, workItemId: string | null | undefined): void {
  if (!workItemId) return;
  if (createdWorkItems.some((entry) => entry.workItemId === workItemId)) return;
  createdWorkItems.push({ factoryId, workItemId });
}

/**
 * Resolves a factory key (`example`, `hello-nextjs`, …) to its committed `fac_<ulid>` id.
 * Console URLs and the API address factories only by that id; a directory name is never a
 * valid URL segment anymore.
 */
export async function factoryId(
  request: APIRequestContext,
  key = 'example',
): Promise<string> {
  const cached = factoryIds.get(key);
  if (cached) return cached;

  const response = await request.get('/api/v1/factories');
  expect(response.ok(), `GET /api/v1/factories failed: ${response.status()}`).toBeTruthy();
  const body = (await response.json()) as {
    factories: Array<{ id: string | null; key: string; name: string }>;
  };
  const hit = body.factories.find((entry) => entry.name === key || entry.key === key);
  expect(hit?.id, `no factory id for ${key}`).toBeTruthy();
  factoryIds.set(key, hit!.id as string);
  return hit!.id as string;
}

/** A console factory page: `/factories/<id>/<segment>`. */
export async function factoryPage(
  request: APIRequestContext,
  key: string,
  segment = 'dashboard',
): Promise<string> {
  return `/factories/${encodeURIComponent(await factoryId(request, key))}/${segment}`;
}

/** A nested API path under `/api/v1`: `/api/v1/factories/<id>/<path>`. */
export async function factoryApi(
  request: APIRequestContext,
  key: string,
  path: string,
): Promise<string> {
  return `/api/v1/factories/${encodeURIComponent(await factoryId(request, key))}/${path}`;
}

export async function createFakeRun(
  request: APIRequestContext,
  data: Record<string, unknown> = {},
  key?: string,
): Promise<{ id: string; factory: string; definitionCommit: string }> {
  // A caller may name the factory either as `factory` in the body (legacy shape) or as the
  // third argument; the nested route takes the factory from the URL, so strip it from the body.
  const { factory, ...rest } = data;
  const target = key ?? (typeof factory === 'string' ? factory : 'example');
  const url = await factoryApi(request, target, 'chat');
  const response = await request.post(url, {
    data: {
      harness: 'fake',
      prompt: 'e2e: fake harness run',
      ...rest,
    },
  });
  expect(response.ok(), `POST ${url} failed: ${response.status()} ${await response.text()}`).toBeTruthy();
  const body = (await response.json()) as { run: { id: string; factory: string; definitionCommit: string } };
  trackRun(await factoryId(request, target), body.run.id);
  return body.run;
}

export async function cleanupRuns(request: APIRequestContext): Promise<void> {
  for (const entry of created.splice(0)) {
    await request
      .post(
        `/api/v1/factories/${encodeURIComponent(entry.factoryId)}/runs/${encodeURIComponent(entry.runId)}/cancel`,
        { data: { reason: 'e2e cleanup' } },
      )
      .catch(() => undefined);
  }
}

/**
 * Best-effort work-item cleanup through the nested cancel route (harden-runtime, task 1.4):
 * no gate is rejected to clean up anymore. Cancellation is idempotent, so a second call is
 * harmless; a `done` item is refused with `invalid_state` and ignored.
 */
export async function cleanupWorkItems(request: APIRequestContext): Promise<void> {
  for (const entry of createdWorkItems.splice(0)) {
    const base = `/api/v1/factories/${encodeURIComponent(entry.factoryId)}/work-items/${encodeURIComponent(entry.workItemId)}`;
    await request
      .post(`${base}/cancel`, { data: { actor: 'e2e-cleanup', reason: 'e2e cleanup' } })
      .catch(() => undefined);

    for (let attempt = 0; attempt < 20; attempt += 1) {
      const response = await request.get(base).catch(() => undefined);
      if (!response || !response.ok()) break;
      const detail = (await response.json()) as { workItem?: { status?: string } };
      const status = detail.workItem?.status;
      if (status === 'done' || status === 'cancelled') break;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
}

/** Restores the kill switch after a test enabled autonomy for a factory. */
export async function pauseAutonomy(
  request: APIRequestContext,
  factory: string,
): Promise<void> {
  const url = await factoryApi(request, factory, 'autonomy');
  await request
    .post(url, {
      data: {
        enabled: false,
        actor: 'e2e-cleanup',
        reason: 'e2e cleanup: restore the kill switch',
      },
    })
    .catch(() => undefined);
}
