#!/usr/bin/env bun
/**
 * Repeatable hello-nextjs lights-off cycle.
 *
 *   bun scripts/hello-nextjs-cycle.ts
 *   bun scripts/hello-nextjs-cycle.ts --prompt "..." --timeout-min 45
 *   bun scripts/hello-nextjs-cycle.ts --mission --goal "..." --timeout-min 90
 *
 * It preserves the definition, purges the factory through the API, restores the definition
 * with a fresh `fac_` id, syncs the registry, bootstraps the local forge, enables autonomy
 * with an audited override, and runs a real work item (or a full mission with `--mission`)
 * until it reaches a terminal state.
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
const MISSION_GOAL =
  flag('--goal') ??
  'Create a minimal Next.js 15 App Router site in the site/ directory: package.json with next/react/react-dom and dev/build/start scripts, app/layout.tsx, app/page.tsx rendering <h1>Hello, world!</h1>, next.config.ts, and README.md. Add a Playwright smoke test that loads / and asserts the heading. Do not run npm install.';
const VIA_MISSION = args.includes('--mission');
const RESUME = args.includes('--resume');
const STALL_MIN = Number(flag('--stall-min') ?? '15');
const TIMEOUT_MIN = Number(flag('--timeout-min') ?? (VIA_MISSION ? '90' : '45'));

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

/**
 * Progress signal beyond mission-level counts. A feature can stay `running` for a long
 * time while its work item advances through stages and its run streams events; the
 * watchdog must see that activity and not cancel a healthy run.
 */
async function activeRunKey(
  factoryId: string,
  cookie: string,
  workItems: Array<{ id: string; status: string }>,
): Promise<string> {
  const ids = workItems
    .filter((item) => item.status === 'active' || item.status === 'running')
    .map((item) => item.id);
  if (ids.length === 0) return 'no-active-work-items';

  const list = await request(`/factories/${factoryId}/runs?limit=50`, cookie);
  if (!list.ok) return `runs-unavailable:${list.status}`;
  const body = (await list.json()) as {
    runs?: Array<{ id: string; status: string; workItemId: string | null }>;
  };
  const active = (body.runs ?? []).find(
    (run) =>
      run.workItemId !== null &&
      ids.includes(run.workItemId) &&
      (run.status === 'running' || run.status === 'pending'),
  );
  if (!active) return 'no-active-runs';

  const detail = await request(`/factories/${factoryId}/runs/${encodeURIComponent(active.id)}`, cookie);
  if (!detail.ok) return `${active.id}:${active.status}:detail-unavailable:${detail.status}`;
  const run = (await detail.json()) as {
    steps?: Array<{
      step_id?: string;
      status?: string;
      detail?: { lastSeq?: number; appended?: number };
      ended_at?: string | null;
    }>;
  };
  const stream = run.steps?.find((step) => step.step_id === 'stream');
  return `${active.id}:${active.status}:${stream?.status ?? '-'}:${stream?.detail?.lastSeq ?? '-'}:${stream?.detail?.appended ?? '-'}:${stream?.ended_at ?? '-'}`;
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

  const source = join(FACTORY_ROOT, ...existing.path.split('/'));
  if (!existsSync(join(source, 'factory.yaml'))) fail(`definition not found at ${source}`);

  let backup: string | null = null;
  let id: string;
  if (RESUME) {
    id = existing.id;
    console.log(`[cycle] resuming existing ${FACTORY} -> ${id} (no purge/recreate)`);
  } else {
    backup = mkdtempSync(join(tmpdir(), 'hello-nextjs-cycle-'));
    cpSync(source, join(backup, FACTORY), { recursive: true });
    console.log(`[cycle] backed up ${source} -> ${backup}`);

    console.log(`[cycle] purging ${existing.id} (${existing.key})`);
    const purge = await request(`/factories/${encodeURIComponent(existing.id)}?force=1`, cookie, {
      method: 'DELETE',
    });
    if (!purge.ok) fail(`purge failed (${purge.status}): ${await purge.text()}`);
    rmSync(source, { recursive: true, force: true });

    cpSync(join(backup, FACTORY), source, { recursive: true });
    id = newFactoryId();
    const manifestPath = join(source, 'factory.yaml');
    const manifest = readFileSync(manifestPath, 'utf8').replace(/^id: fac_.*$/m, `id: ${id}`);
    writeFileSync(manifestPath, manifest, 'utf8');
    console.log(`[cycle] recreated ${FACTORY} -> ${id}`);

    run(['bun', 'scripts/migrate-factory-identity.ts'], {
      DATABASE_URL,
      FACTORY_ROOT,
    });
    run(['bash', 'scripts/forgejo-bootstrap.sh']);
  }

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

  if (VIA_MISSION) {
    const title = `Mission: hello-world Next.js site (${new Date().toISOString()})`;
    const createdResponse = await request(`/factories/${id}/missions`, cookie, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title,
        goal: MISSION_GOAL,
        budget: { maxCostUsd: 25, maxRuns: 50, maxWallClockHours: 4 },
      }),
    });
    const created = (await createdResponse.json()) as {
      mission?: { id: string; status: string; workflowId: string | null };
      message?: string;
    };
    if (!createdResponse.ok || !created.mission) {
      fail(`create mission failed (${createdResponse.status}): ${JSON.stringify(created)}`);
    }
    const missionId = created.mission.id;
    console.log(
      `[cycle] mission ${missionId} started at ${created.mission.status} workflow=${created.mission.workflowId ?? '-'}`,
    );

    const deadline = Date.now() + TIMEOUT_MIN * 60 * 1000;
    let last = '';
    let lastProgressKey = '';
    let lastProgressAt = Date.now();
    let lastCheckAt = Date.now();
    while (Date.now() < deadline) {
      const detailResponse = await request(`/factories/${id}/missions/${missionId}`, cookie);
      if (!detailResponse.ok) fail(`mission detail failed (${detailResponse.status})`);
      const detail = (await detailResponse.json()) as {
        mission: {
          status: string;
          planVersion: number;
          error?: string | null;
          featureDone: number;
          featureTotal: number;
          featureFailed: number;
          milestoneDone: number;
          milestoneTotal: number;
          currentFeatureId: string | null;
          spendUsd: number;
          updatedAt: string | null;
          workflowId: string | null;
        };
        features: Array<{ id: string; title: string; status: string; workItemId: string | null }>;
        validations: Array<{ kind: string; round: number; status: string; verdict: string | null }>;
        workItems: Array<{
          id: string;
          stage: string;
          status: string;
          prUrl: string | null;
          prNumber: number | null;
          updatedAt: string | null;
        }>;
      };
      const mission = detail.mission;
      const line = `${mission.status} plan=${mission.planVersion} features=${mission.featureDone}/${mission.featureTotal} failed=${mission.featureFailed} milestones=${mission.milestoneDone}/${mission.milestoneTotal} validations=${detail.validations.length} spend=${mission.spendUsd} current=${mission.currentFeatureId ?? '-'} error=${mission.error ?? '-'}`;
      if (line !== last) {
        console.log(`[cycle] ${new Date().toISOString()} ${line}`);
        last = line;
      }

      const workItemKey = detail.workItems
        .map(
          (item) =>
            `${item.id}:${item.stage}:${item.status}:${item.prUrl ?? ''}:${item.updatedAt ?? ''}`,
        )
        .join(',');
      const runKey = await activeRunKey(id, cookie, detail.workItems);
      const progressKey = `${mission.status}|${mission.planVersion}|${mission.featureDone}/${mission.featureTotal}|${mission.featureFailed}|${mission.milestoneDone}/${mission.milestoneTotal}|${detail.validations.length}|${mission.currentFeatureId ?? ''}|${mission.error ?? ''}|${workItemKey}|${runKey}`;
      if (progressKey !== lastProgressKey) {
        lastProgressKey = progressKey;
        lastProgressAt = Date.now();
      }
      if (Date.now() - lastCheckAt >= 5 * 60 * 1000) {
        lastCheckAt = Date.now();
        const stalledMin = (Date.now() - lastProgressAt) / (60 * 1000);
        console.log(
          `[cycle] progress check: stalled=${stalledMin.toFixed(1)}m status=${mission.status} plan=${mission.planVersion} features=${mission.featureDone}/${mission.featureTotal} validations=${detail.validations.length} workflow=${mission.workflowId ?? '-'}`,
        );
        if (stalledMin >= STALL_MIN) {
          console.log(
            `[cycle] STALL: no mission progress for ${stalledMin.toFixed(1)} minutes (threshold ${STALL_MIN}m); cancelling ${missionId}`,
          );
          const cancelled = await request(
            `/factories/${id}/missions/${missionId}/cancel`,
            cookie,
            {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                actor: 'cycle',
                reason: `progress watchdog: no progress for ${stalledMin.toFixed(1)} minutes`,
              }),
            },
          );
          console.log(`[cycle] cancel response: ${cancelled.status} ${await cancelled.text()}`);
          if (backup) rmSync(backup, { recursive: true, force: true });
          fail(
            `mission stalled for ${stalledMin.toFixed(1)} minutes at status ${mission.status}; inspect worker/Temporal logs`,
          );
        }
      }
      if (['done', 'failed', 'blocked', 'cancelled'].includes(mission.status)) {
        const prs = detail.workItems
          .filter((item) => item.prUrl)
          .map((item) => `${item.id} ${item.prUrl}`);
        console.log(
          `[cycle] mission terminal ${JSON.stringify({
            status: mission.status,
            error: mission.error ?? null,
            features: detail.features.map((feature) => ({
              title: feature.title,
              status: feature.status,
              workItemId: feature.workItemId,
            })),
            validations: detail.validations,
            prs,
          })}`,
        );
        const containers = Bun.spawnSync({
          cmd: ['docker', 'ps', '-a', '--filter', 'label=factory.run', '-q'],
          stdout: 'pipe',
        });
        const count = containers.stdout.toString().trim().split('\n').filter(Boolean).length;
        console.log(`[cycle] managed runner containers: ${count}`);
        if (backup) rmSync(backup, { recursive: true, force: true });
        process.exit(mission.status === 'done' ? 0 : 1);
      }
      await new Promise((resolveSleep) => setTimeout(resolveSleep, 15_000));
    }

    const cancelled = await request(
      `/factories/${id}/missions/${missionId}/cancel`,
      cookie,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          actor: 'cycle',
          reason: `mission timed out after ${TIMEOUT_MIN} minutes`,
        }),
      },
    );
    console.log(`[cycle] cancel response: ${cancelled.status} ${await cancelled.text()}`);
    if (backup) rmSync(backup, { recursive: true, force: true });
    fail(`mission timed out after ${TIMEOUT_MIN} minutes`);
  }

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
      if (backup) rmSync(backup, { recursive: true, force: true });
      process.exit(item.status === 'done' ? 0 : 1);
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 15_000));
  }

  rmSync(backup, { recursive: true, force: true });
  fail(`timed out after ${TIMEOUT_MIN} minutes`);
}

await main();
