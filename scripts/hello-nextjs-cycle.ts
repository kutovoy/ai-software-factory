#!/usr/bin/env bun
/**
 * Repeatable hello-nextjs lights-off cycle.
 *
 *   bun scripts/hello-nextjs-cycle.ts
 *   bun scripts/hello-nextjs-cycle.ts --prompt "..." --timeout-min 45
 *
 * It preserves the definition, purges the factory through the API, restores the definition
 * with a fresh `fac_` id, syncs the registry, bootstraps the local forge, enables autonomy
 * with an audited override, and runs a real work item until it reaches a terminal state.
 *
 * This is a verification harness, not a product path. It intentionally uses the same API
 * and scripts an operator would use.
 */
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { newFactoryId } from '../packages/core/src/index';

const args = process.argv.slice(2);
function flag(name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

const RAW_API = (process.env.API_BASE_URL ?? 'http://localhost:8080').replace(/\/+$/, '');
const API = /\/api\/v1$/.test(RAW_API) ? RAW_API : `${RAW_API}/api/v1`;
const FACTORY_ROOT = resolve(process.env.FACTORY_ROOT ?? './factories');
const FACTORY = 'hello-nextjs';
const ADMIN_EMAIL = process.env.FACTORY_ADMIN_EMAIL ?? 'admin@factory.local';
const ADMIN_PASSWORD = process.env.FACTORY_ADMIN_PASSWORD ?? 'factory-admin';
const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://factory:factory@localhost:5433/factory';
const PROMPT =
  flag('--prompt') ??
  'Create a minimal Next.js 15 App Router site in the site/ directory: package.json with next/react/react-dom and dev/build/start scripts, app/layout.tsx, app/page.tsx rendering <h1>Hello, world!</h1>, next.config.ts, and README.md. Do not run npm install. Then review it with two independent reviewers, verify it in a real browser with Playwright, and ship it through the forge.';
const TIMEOUT_MIN = Number(flag('--timeout-min') ?? '45');

function fail(message: string): never {
  console.error(`[cycle] FAIL: ${message}`);
  process.exit(1);
}

function run(command: string[], env: Record<string, string> = {}): void {
  const result = Bun.spawnSync({
    cmd: command,
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    stdout: 'inherit',
    stderr: 'inherit',
  });
  if (result.exitCode !== 0) fail(`${command.join(' ')} exited ${result.exitCode}`);
}

async function login(): Promise<string> {
  const response = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });
  if (!response.ok) fail(`login failed (${response.status})`);
  const cookie = (response.headers.get('set-cookie') ?? '').split(';')[0];
  if (!cookie) fail('login returned no factory_session cookie');
  return cookie;
}

async function request(path: string, cookie: string, init: RequestInit = {}): Promise<Response> {
  return await fetch(`${API}${path}`, {
    ...init,
    headers: { accept: 'application/json', cookie, ...(init.headers ?? {}) },
  });
}

async function main(): Promise<void> {
  const cookie = await login();
  const list = await request('/factories', cookie);
  if (!list.ok) fail(`GET /factories failed (${list.status})`);
  const body = (await list.json()) as {
    factories?: Array<{ id: string | null; key: string; name: string; path: string }>;
  };
  const existing = (body.factories ?? []).find(
    (factory) => factory.key === FACTORY || factory.name === FACTORY,
  );
  if (!existing?.id) fail(`factory ${FACTORY} is not registered`);

  const backup = mkdtempSync(join(tmpdir(), 'hello-nextjs-cycle-'));
  const source = join(FACTORY_ROOT, ...existing.path.split('/'));
  if (!existsSync(join(source, 'factory.yaml'))) fail(`definition not found at ${source}`);
  cpSync(source, join(backup, FACTORY), { recursive: true });
  console.log(`[cycle] backed up ${source} -> ${backup}`);

  console.log(`[cycle] purging ${existing.id} (${existing.key})`);
  const purge = await request(`/factories/${encodeURIComponent(existing.id)}?force=1`, cookie, {
    method: 'DELETE',
  });
  if (!purge.ok) fail(`purge failed (${purge.status}): ${await purge.text()}`);
  rmSync(source, { recursive: true, force: true });

  cpSync(join(backup, FACTORY), source, { recursive: true });
  const id = newFactoryId();
  const manifestPath = join(source, 'factory.yaml');
  const manifest = readFileSync(manifestPath, 'utf8').replace(/^id: fac_.*$/m, `id: ${id}`);
  writeFileSync(manifestPath, manifest, 'utf8');
  console.log(`[cycle] recreated ${FACTORY} -> ${id}`);

  run(['bun', 'scripts/migrate-factory-identity.ts'], {
    DATABASE_URL,
    FACTORY_ROOT,
  });
  run(['bash', 'scripts/forgejo-bootstrap.sh']);

  const autonomy = await request(`/factories/${id}/autonomy`, cookie, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      enabled: true,
      actor: 'cycle',
      reason: 'hello-nextjs lights-off verification cycle',
      override: {
        actor: 'cycle',
        reason: 'fresh factory has no benchmark attestation; audited verification override',
      },
    }),
  });
  if (!autonomy.ok) fail(`autonomy failed (${autonomy.status}): ${await autonomy.text()}`);
  console.log('[cycle] autonomy enabled with audited override');

  const title = `Build the hello-world Next.js site (${new Date().toISOString()})`;
  const viaIntake = args.includes('--intake');
  const createdResponse = viaIntake
    ? await request(`/factories/${id}/intake/generic`, cookie, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title,
          prompt: PROMPT,
          externalId: `cycle-${Date.now()}`,
        }),
      })
    : await request(`/factories/${id}/work-items`, cookie, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title,
          type: 'task',
          source: 'manual',
          prompt: PROMPT,
        }),
      });
  const created = (await createdResponse.json()) as {
    workItem?: { id: string; stage: string; status: string; workflowId?: string };
  };
  if (!createdResponse.ok || !created.workItem) {
    fail(`create work item failed (${createdResponse.status}): ${JSON.stringify(created)}`);
  }
  const workItemId = created.workItem.id;
  console.log(
    `[cycle] work item ${workItemId} started at ${created.workItem.stage}/${created.workItem.status}${viaIntake ? ' via generic intake' : ''}`,
  );

  const deadline = Date.now() + TIMEOUT_MIN * 60 * 1000;
  let last = '';
  while (Date.now() < deadline) {
    const detailResponse = await request(`/factories/${id}/work-items/${workItemId}`, cookie);
    if (!detailResponse.ok) fail(`work item detail failed (${detailResponse.status})`);
    const detail = (await detailResponse.json()) as {
      workItem: {
        status: string;
        stage: string;
        attempt: number;
        prUrl: string | null;
        prNumber: number | null;
        error?: string | null;
        summary?: string | null;
      };
      pendingGate?: { stage: string } | null;
    };
    const item = detail.workItem;
    const line = `${item.status}/${item.stage} attempt=${item.attempt} pending=${
      detail.pendingGate?.stage ?? '-'
    } pr=${item.prUrl ?? '-'}`;
    if (line !== last) {
      console.log(`[cycle] ${new Date().toISOString()} ${line}`);
      last = line;
    }
    if (['done', 'failed', 'blocked', 'cancelled', 'escalated'].includes(item.status)) {
      console.log(
        `[cycle] terminal ${JSON.stringify({
          status: item.status,
          stage: item.stage,
          prUrl: item.prUrl,
          prNumber: item.prNumber,
          error: item.error ?? null,
          summary: item.summary ?? null,
        })}`,
      );
      const containers = Bun.spawnSync({
        cmd: ['docker', 'ps', '-a', '--filter', 'label=factory.run', '-q'],
        stdout: 'pipe',
      });
      const count = containers.stdout.toString().trim().split('\n').filter(Boolean).length;
      console.log(`[cycle] managed runner containers: ${count}`);
      rmSync(backup, { recursive: true, force: true });
      process.exit(item.status === 'done' ? 0 : 1);
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 15_000));
  }

  rmSync(backup, { recursive: true, force: true });
  fail(`timed out after ${TIMEOUT_MIN} minutes`);
}

await main();
