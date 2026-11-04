/**
 * Surface-agnostic client (roadmap item 11).
 *
 * The CLI and CI surfaces reuse the same API paths as the console: chat runs go through
 * `POST /factories/:id/chat`, external intake goes through `/intake/:provider`, and both
 * start the same adapter → runner path. No surface gets a private execution path.
 */

export interface SurfaceOptions {
  apiUrl?: string;
  email?: string;
  password?: string;
  cookie?: string;
}

export interface SurfaceRun {
  runId: string;
  workflowId: string;
  status?: string;
  summary?: string | null;
  error?: string | null;
}

export function surfaceApiBase(value = process.env.API_BASE_URL ?? 'http://localhost:8080'): string {
  const base = value.replace(/\/+$/, '');
  return /\/api\/v1$/.test(base) ? base : `${base}/api/v1`;
}

async function login(options: SurfaceOptions): Promise<string> {
  if (options.cookie) return options.cookie;
  const base = surfaceApiBase(options.apiUrl);
  const response = await fetch(`${base}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: options.email ?? process.env.FACTORY_ADMIN_EMAIL ?? 'admin@factory.local',
      password: options.password ?? process.env.FACTORY_ADMIN_PASSWORD ?? 'factory-admin',
    }),
  });
  if (!response.ok) throw new Error(`login failed (${response.status})`);
  const cookie = (response.headers.get('set-cookie') ?? '').split(';')[0];
  if (!cookie) throw new Error('login returned no session cookie');
  return cookie;
}

async function request(
  options: SurfaceOptions,
  path: string,
  init: RequestInit,
): Promise<Response> {
  const base = surfaceApiBase(options.apiUrl);
  const cookie = await login(options);
  return fetch(`${base}${path}`, {
    ...init,
    headers: { accept: 'application/json', cookie, ...(init.headers ?? {}) },
  });
}

/** Starts a chat run through the same API the console uses. */
export async function surfaceChat(
  factoryId: string,
  prompt: string,
  options: SurfaceOptions & { model?: string; harness?: string; title?: string } = {},
): Promise<SurfaceRun> {
  const response = await request(options, `/factories/${encodeURIComponent(factoryId)}/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      prompt,
      ...(options.model ? { model: options.model } : {}),
      ...(options.harness ? { harness: options.harness } : {}),
      ...(options.title ? { title: options.title } : {}),
    }),
  });
  const body = (await response.json()) as {
    run?: { id: string };
    workflow?: { workflowId: string };
    error?: string;
  };
  if (!response.ok || !body.run) {
    throw new Error(`chat failed (${response.status}): ${body.error ?? JSON.stringify(body)}`);
  }
  return { runId: body.run.id, workflowId: body.workflow?.workflowId ?? '' };
}

/** Creates a work item through an intake provider (Slack/CI/generic). */
export async function surfaceIntake(
  factoryId: string,
  provider: string,
  payload: unknown,
  options: SurfaceOptions = {},
): Promise<{ status: string; workItemId?: string }> {
  const response = await request(
    options,
    `/factories/${encodeURIComponent(factoryId)}/intake/${encodeURIComponent(provider)}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    },
  );
  const body = (await response.json()) as {
    status?: string;
    workItem?: { id: string };
    error?: string;
  };
  if (!response.ok) {
    throw new Error(`intake failed (${response.status}): ${body.error ?? JSON.stringify(body)}`);
  }
  return {
    status: body.status ?? 'accepted',
    ...(body.workItem ? { workItemId: body.workItem.id } : {}),
  };
}

/** Polls a chat run until it reaches a terminal state. */
export async function surfaceWait(
  factoryId: string,
  runId: string,
  options: SurfaceOptions & { timeoutMs?: number } = {},
): Promise<SurfaceRun> {
  const deadline = Date.now() + (options.timeoutMs ?? 10 * 60 * 1000);
  while (Date.now() < deadline) {
    const response = await request(
      options,
      `/factories/${encodeURIComponent(factoryId)}/runs/${encodeURIComponent(runId)}`,
      { method: 'GET' },
    );
    const body = (await response.json()) as {
      run?: { id: string; status: string; summary?: string | null; error?: string | null };
      error?: string;
    };
    if (!response.ok || !body.run) {
      throw new Error(`run read failed (${response.status}): ${body.error ?? JSON.stringify(body)}`);
    }
    if (['ok', 'error', 'cancelled'].includes(body.run.status)) {
      return {
        runId: body.run.id,
        workflowId: '',
        status: body.run.status,
        summary: body.run.summary ?? null,
        error: body.run.error ?? null,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`run ${runId} did not reach a terminal state in time`);
}
