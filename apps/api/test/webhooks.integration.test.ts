import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { SQL } from 'bun';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { closeClient, getSql } from '@factory/orchestration';
import { setWorkItemStatus } from '@factory/core';
import { createApp } from '../src/app';
import { loadApiConfig, type ApiConfig } from '../src/config';
import { signGithubPayload } from '../src/webhooks';

/**
 * Webhook ingestion end to end (spec `automations`, ADR-023).
 *
 * Opt-in (needs Postgres + Temporal for the workflow start):
 *
 *   DATABASE_URL=postgres://factory:factory@localhost:5433/factory \
 *   TEMPORAL_ADDRESS=localhost:7233 RUN_INTEGRATION=1 \
 *   bun test apps/api/test/webhooks.integration.test.ts
 */

const enabled =
  process.env.RUN_INTEGRATION === '1' &&
  Boolean(process.env.DATABASE_URL) &&
  Boolean(process.env.TEMPORAL_ADDRESS);

const suite = enabled ? describe : describe.skip;

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');
const MIGRATIONS = join(REPO_ROOT, 'packages', 'core', 'migrations');
const FACTORY = 'example';
const SECRET = 'whsec_webhook_itest';

let config: ApiConfig;
let app: Hono;
const createdWorkItems: string[] = [];

async function migrate(databaseUrl: string): Promise<void> {
  const sql = new SQL(databaseUrl, { max: 1 });
  try {
    // Mirrors `scripts/migrate.ts`: apply each file once (recorded in schema_migrations).
    // Re-running every file against a dirty database would recreate indexes over data
    // that violates them (the compose database is shared across suites).
    await sql`create table if not exists schema_migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    )`;
    const applied = new Set(
      ((await sql`select name from schema_migrations`) as { name: string }[]).map((row) => row.name),
    );
    const files = (await readdir(MIGRATIONS)).filter((file) => file.endsWith('.sql')).sort();
    for (const file of files) {
      if (applied.has(file)) continue;
      await sql.unsafe(await readFile(join(MIGRATIONS, file), 'utf8'));
      await sql`insert into schema_migrations (name) values (${file}) on conflict do nothing`;
    }
  } finally {
    await sql.close();
  }
}

function issuePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: 'labeled',
    repository: { full_name: 'acme/api-service' },
    sender: { login: 'ada', type: 'User' },
    label: { name: 'factory-ready' },
    issue: {
      number: 4242,
      title: 'Retry the API client',
      html_url: 'https://github.com/acme/api-service/issues/4242',
      labels: [{ name: 'factory-ready' }],
    },
    ...overrides,
  };
}

async function deliver(
  payload: Record<string, unknown>,
  options: { signature?: string | null; deliveryId?: string; event?: string } = {},
): Promise<{ status: number; body: any }> {
  const raw = JSON.stringify(payload);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-github-event': options.event ?? 'issues',
    'x-github-delivery': options.deliveryId ?? `delivery-${Date.now()}-${Math.random()}`,
  };
  const signature = options.signature === undefined ? signGithubPayload(raw, SECRET) : options.signature;
  if (signature) headers['x-hub-signature-256'] = signature;

  const response = await app.request('/webhooks/github', {
    method: 'POST',
    headers,
    body: raw,
  });
  return { status: response.status, body: await response.json() };
}

suite('webhook ingestion', () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.DATABASE_URL as string;
    process.env.TEMPORAL_ADDRESS = process.env.TEMPORAL_ADDRESS as string;
    process.env.TEMPORAL_TASK_QUEUE = `factory-webhook-itest-${process.pid}-${Date.now()}`;
    process.env.FACTORY_ROOT = join(REPO_ROOT, 'factories');
    process.env.REPO_ROOT = REPO_ROOT;
    process.env.GITHUB_WEBHOOK_SECRET = SECRET;

    await migrate(process.env.DATABASE_URL as string);
    config = loadApiConfig();
    app = createApp(config);

    const configured = await app.request('/integrations/github', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        factory: FACTORY,
        secretRef: 'GITHUB_TOKEN',
        webhookSecretRef: 'GITHUB_WEBHOOK_SECRET',
        repos: [{ owner: 'acme', name: 'api-service' }],
        events: ['issues'],
        labels: ['factory-ready'],
        mergeQueue: true,
        dryRun: true,
      }),
    });
    expect(configured.status).toBe(200);
  }, 60_000);

  afterAll(async () => {
    const sql = getSql();
    for (const workItemId of createdWorkItems.splice(0)) {
      await setWorkItemStatus(sql, {
        workItemId,
        status: 'cancelled',
        actor: 'itest',
        reason: 'itest cleanup',
      }).catch(() => undefined);
    }
    await closeClient();
  }, 30_000);

  test('an unsigned delivery is rejected with invalid_signature and creates no work item', async () => {
    const before = await getSql()`
      select count(*)::int as count from work_items where factory = ${FACTORY} and source = 'forge'
    `;

    const unsigned = await deliver(issuePayload(), { signature: null });
    expect(unsigned.status).toBe(401);
    expect(unsigned.body.code).toBe('invalid_signature');

    const forged = await deliver(issuePayload(), { signature: signGithubPayload('{}', SECRET) });
    expect(forged.status).toBe(401);
    expect(forged.body.code).toBe('invalid_signature');

    const after = await getSql()`
      select count(*)::int as count from work_items where factory = ${FACTORY} and source = 'forge'
    `;
    expect(after[0]?.count).toBe(before[0]?.count);

    const rejected = await getSql()`
      select count(*)::int as count from webhook_deliveries
      where provider = 'github' and status = 'rejected'
    `;
    expect(rejected[0]?.count).toBeGreaterThanOrEqual(2);
  }, 30_000);

  test('a signed labeled issue creates a forge work item with a sourceRef', async () => {
    const deliveryId = `delivery-accept-${Date.now()}`;
    const accepted = await deliver(issuePayload(), { deliveryId });
    expect(accepted.status).toBe(202);
    expect(accepted.body.status).toBe('accepted');
    expect(accepted.body.factory).toBe(FACTORY);
    expect(accepted.body.workItemId).toMatch(/^wi_/);
    createdWorkItems.push(accepted.body.workItemId);

    const detail = await app.request(`/work-items/${accepted.body.workItemId}`);
    const body = (await detail.json()) as {
      workItem: {
        source: string;
        type: string;
        title: string;
        sourceRef: Record<string, unknown>;
      };
    };
    expect(body.workItem.source).toBe('forge');
    expect(body.workItem.type).toBe('task');
    expect(body.workItem.title).toBe('Retry the API client');
    expect(body.workItem.sourceRef).toMatchObject({
      kind: 'issue',
      id: 4242,
      repo: 'acme/api-service',
      event: 'issues',
      action: 'labeled',
      deliveryId,
      untrusted: true,
    });

    // The delivery row records the acceptance and the item it produced.
    const delivery = await app.request(`/webhook-deliveries/${deliveryId}`);
    const deliveryBody = (await delivery.json()) as {
      delivery: { status: string; workItemId: string; factory: string };
    };
    expect(deliveryBody.delivery.status).toBe('accepted');
    expect(deliveryBody.delivery.workItemId).toBe(accepted.body.workItemId);
    expect(deliveryBody.delivery.factory).toBe(FACTORY);
  }, 60_000);

  test('a redelivered delivery id is acknowledged and ignored', async () => {
    const deliveryId = `delivery-dup-${Date.now()}`;
    const forgeItems = async (): Promise<number> => {
      const rows = await getSql()`
        select count(*)::int as count from work_items
        where factory = ${FACTORY} and source = 'forge'
      `;
      return Number(rows[0]?.count ?? 0);
    };
    const before = await forgeItems();

    const first = await deliver(issuePayload(), { deliveryId });
    expect(first.status).toBe(202);
    expect(first.body.status).toBe('accepted');
    createdWorkItems.push(first.body.workItemId);
    expect(await forgeItems()).toBe(before + 1);

    const second = await deliver(issuePayload(), { deliveryId });
    expect(second.status).toBe(202);
    expect(second.body.status).toBe('ignored');
    expect(second.body.reason).toBe('duplicate_delivery');
    // No second work item for the redelivery.
    expect(await forgeItems()).toBe(before + 1);

    const delivery = await app.request(`/webhook-deliveries/${deliveryId}`);
    const body = (await delivery.json()) as {
      delivery: { status: string; workItemId: string; factory: string };
    };
    expect(body.delivery.status).toBe('accepted');
    expect(body.delivery.workItemId).toBe(first.body.workItemId);
  }, 60_000);

  test('a bot sender is skipped by default and recorded', async () => {
    const deliveryId = `delivery-bot-${Date.now()}`;
    const result = await deliver(
      issuePayload({ sender: { login: 'renovate[bot]', type: 'Bot' } }),
      { deliveryId },
    );
    expect(result.status).toBe(202);
    expect(result.body.status).toBe('ignored');
    expect(result.body.reason).toBe('bot_sender');

    const delivery = await app.request(`/webhook-deliveries/${deliveryId}`);
    const body = (await delivery.json()) as { delivery: { status: string; reason: string } };
    expect(body.delivery.status).toBe('ignored');
    expect(body.delivery.reason).toBe('bot_sender');
  }, 30_000);

  test('a non-matching event is acknowledged and ignored with a reason', async () => {
    const result = await deliver(
      issuePayload({ repository: { full_name: 'other/repo' } }),
      { deliveryId: `delivery-other-${Date.now()}` },
    );
    expect(result.status).toBe(202);
    expect(result.body.status).toBe('ignored');
    expect(result.body.reason).toBe('no_matching_filter');

    const unlabelled = await deliver(
      issuePayload({ label: { name: 'bug' }, issue: { number: 1, title: 'x', labels: [] } }),
      { deliveryId: `delivery-label-${Date.now()}` },
    );
    expect(unlabelled.body.reason).toBe('no_matching_filter');
  }, 30_000);

  test('a payload beyond the cap is rejected before parsing', async () => {
    const big = issuePayload({ padding: 'x'.repeat(config.webhookMaxBytes + 100) });
    const result = await deliver(big, { deliveryId: `delivery-big-${Date.now()}` });
    expect(result.status).toBe(413);
    expect(result.body.code).toBe('payload_too_large');
  }, 30_000);

  test('the integration projection reports the connection by reference', async () => {
    const response = await app.request(`/factories/${FACTORY}/integrations`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      github: {
        configured: boolean;
        secretRef: string;
        webhookSecretRef: string;
        webhookSecretConfigured: boolean;
        webhookUrl: string;
        repos: { owner: string; name: string }[];
        mergeQueue: boolean;
        dryRun: boolean;
        events: string[];
        labels: string[];
      };
    };
    expect(body.github.configured).toBe(true);
    expect(body.github.secretRef).toBe('GITHUB_TOKEN');
    expect(body.github.webhookSecretRef).toBe('GITHUB_WEBHOOK_SECRET');
    expect(body.github.webhookSecretConfigured).toBe(true);
    expect(body.github.webhookUrl).toContain('/webhooks/github');
    expect(body.github.repos).toEqual([{ owner: 'acme', name: 'api-service' }]);
    expect(body.github.mergeQueue).toBe(true);
    expect(body.github.dryRun).toBe(true);
    expect(body.github.events).toEqual(['issues']);
    expect(body.github.labels).toEqual(['factory-ready']);
  }, 30_000);

  test('a token value is refused as a secret reference', async () => {
    const response = await app.request('/integrations/github', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        factory: FACTORY,
        secretRef: 'ghp_abcdefghijklmnopqrstuvwxyz0123',
      }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { code: string };
    expect(body.code).toBe('invalid_request');
  }, 30_000);

  test('the automations projection lists webhook and cron status', async () => {
    const response = await app.request(`/factories/${FACTORY}/automations`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      automations: {
        name: string;
        cron: string | null;
        schedule: { status: string } | null;
        webhook: { deliveries: number; accepted: number };
      }[];
      webhook: { url: string; secretRef: string };
    };
    const nightly = body.automations.find((entry) => entry.name === 'nightly');
    expect(nightly?.cron).toBe('0 3 * * *');
    const intake = body.automations.find((entry) => entry.name === 'intake');
    expect(intake?.webhook.accepted).toBeGreaterThanOrEqual(1);
    expect(body.webhook.secretRef).toBe('GITHUB_WEBHOOK_SECRET');
    expect(body.webhook.url).toContain('/webhooks/github');
  }, 30_000);
});
