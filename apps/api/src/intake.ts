import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { Hono } from 'hono';
import {
  listWebhookDeliveries,
  markWebhookDelivery,
  recordWebhookDelivery,
  type WorkItemSource,
} from '@factory/core';
import { getSql } from '@factory/orchestration';
import type { ApiConfig } from './config';
import { ApiError } from './errors';
import { resolveSecret } from './secrets';
import { createWorkItemForApi, type CreatedWorkItem } from './work-items';
import { frameUntrusted } from './webhooks';

/**
 * Work intake from anywhere (roadmap item 8).
 *
 * A single nested endpoint accepts provider-shaped payloads, verifies the provider's
 * signature when a secret is configured, dedupes by an external delivery id, frames the
 * payload as untrusted data and creates a normal work item. The factory loop is unchanged:
 * intake only decides *what* enters, never how it runs.
 */

export const INTAKE_PROVIDERS = ['generic', 'sentry', 'posthog', 'slack', 'linear', 'jira'] as const;
export type IntakeProvider = (typeof INTAKE_PROVIDERS)[number];

const PROVIDER_SOURCE: Record<IntakeProvider, WorkItemSource> = {
  generic: 'api',
  sentry: 'sentry',
  posthog: 'posthog',
  slack: 'slack',
  linear: 'linear',
  jira: 'jira',
};

const PROVIDER_SECRET: Record<IntakeProvider, string> = {
  generic: 'FACTORY_INTAKE_SECRET',
  sentry: 'SENTRY_WEBHOOK_SECRET',
  posthog: 'POSTHOG_WEBHOOK_SECRET',
  slack: 'SLACK_SIGNING_SECRET',
  linear: 'LINEAR_WEBHOOK_SECRET',
  jira: 'JIRA_WEBHOOK_SECRET',
};

export interface IntakeResult {
  status: 'accepted' | 'ignored';
  reason?: string;
  workItem?: CreatedWorkItem['workItem'];
}

function secretFor(provider: IntakeProvider): string | null {
  const name = PROVIDER_SECRET[provider];
  return resolveSecret(name) ?? process.env[name] ?? null;
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Provider-specific HMAC verification; no secret configured means local/dev intake. */
export function verifyIntakeSignature(
  provider: IntakeProvider,
  raw: string,
  headers: Record<string, string | undefined>,
  secret: string | null,
): boolean {
  if (!secret) return true;
  if (provider === 'slack') {
    const timestamp = headers['x-slack-request-timestamp'] ?? '';
    const signature = headers['x-slack-signature'] ?? '';
    if (!timestamp || !signature.startsWith('v0=')) return false;
    const expected = `v0=${createHmac('sha256', secret)
      .update(`v0:${timestamp}:${raw}`, 'utf8')
      .digest('hex')}`;
    return safeEqual(signature, expected);
  }

  const header =
    headers['x-factory-signature'] ??
    headers['sentry-hook-signature'] ??
    headers['x-posthog-signature'] ??
    headers['linear-signature'] ??
    headers['x-jira-signature'];
  if (!header) return false;
  const provided = header.replace(/^sha256=/i, '').trim();
  const expected = createHmac('sha256', secret).update(raw, 'utf8').digest('hex');
  return safeEqual(provided, expected);
}

function parseBody(provider: IntakeProvider, raw: string): Record<string, unknown> {
  if (provider === 'slack' && !raw.trim().startsWith('{')) {
    return Object.fromEntries(new URLSearchParams(raw));
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // handled below
  }
  throw new ApiError('invalid_payload', 400, 'intake payload must be a JSON object');
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

interface NormalizedIntake {
  title: string;
  prompt: string;
  externalId: string;
  url: string | null;
  type: 'task' | 'bug' | 'incident' | 'pr_review';
}

function normalize(provider: IntakeProvider, body: Record<string, unknown>, raw: string): NormalizedIntake {
  if (provider === 'sentry') {
    const data = record(body.data);
    const issue = record(data.issue ?? body.issue);
    const title = str(issue.title) ?? str(body.message) ?? 'Sentry issue';
    return {
      title,
      prompt: frameUntrusted(
        [title, str(issue.culprit), str(issue.url) ?? str(body.url)].filter(Boolean).join('\n'),
      ),
      externalId: str(issue.id) ?? str(body.event_id) ?? createHash('sha256').update(raw).digest('hex'),
      url: str(issue.url) ?? str(body.url),
      type: 'incident',
    };
  }

  if (provider === 'posthog') {
    const event = str(body.event) ?? 'posthog event';
    const properties = record(body.properties);
    const title = `PostHog: ${event}`;
    return {
      title: title.slice(0, 200),
      prompt: frameUntrusted(
        [title, str(properties.$current_url), str(properties.distinct_id)].filter(Boolean).join('\n'),
      ),
      externalId:
        str(body.uuid) ??
        str(body.event_id) ??
        createHash('sha256').update(raw).digest('hex'),
      url: str(properties.$current_url),
      type: 'bug',
    };
  }

  if (provider === 'slack') {
    const text = str(body.text) ?? str(body.command) ?? 'Slack request';
    const title = text.split('\n')[0]?.slice(0, 200) ?? 'Slack request';
    return {
      title,
      prompt: frameUntrusted(
        [text, str(body.channel_name), str(body.user_name)].filter(Boolean).join('\n'),
      ),
      externalId:
        str(body.trigger_id) ??
        str(body.event_id) ??
        createHash('sha256').update(raw).digest('hex'),
      url: null,
      type: 'task',
    };
  }

  if (provider === 'linear') {
    const data = record(body.data);
    const title = str(data.title) ?? 'Linear issue';
    return {
      title: title.slice(0, 200),
      prompt: frameUntrusted(
        [title, str(data.description), str(data.url) ?? str(data.identifier)].filter(Boolean).join('\n'),
      ),
      externalId:
        str(data.id) ??
        str(data.identifier) ??
        createHash('sha256').update(raw).digest('hex'),
      url: str(data.url),
      type: 'task',
    };
  }

  if (provider === 'jira') {
    const issue = record(body.issue);
    const fields = record(issue.fields);
    const title = str(fields.summary) ?? str(body.summary) ?? 'Jira issue';
    return {
      title: title.slice(0, 200),
      prompt: frameUntrusted(
        [title, str(body.webhookEvent), str(issue.self) ?? str(body.url)].filter(Boolean).join('\n'),
      ),
      externalId:
        str(issue.id) ??
        str(issue.key) ??
        str(body.webhookEvent) ??
        createHash('sha256').update(raw).digest('hex'),
      url: str(issue.self) ?? str(body.url),
      type: 'task',
    };
  }

  const title = str(body.title) ?? str(body.summary) ?? 'API intake';
  return {
    title: title.slice(0, 200),
    prompt: frameUntrusted(
      [title, str(body.prompt) ?? str(body.description) ?? '', str(body.url) ?? '']
        .filter((part) => part !== '')
        .join('\n'),
    ),
    externalId:
      str(body.externalId) ??
      str(body.deliveryId) ??
      createHash('sha256').update(raw).digest('hex'),
    url: str(body.url),
    type: 'task',
  };
}

export async function intakeForApi(
  config: ApiConfig,
  factory: string,
  provider: IntakeProvider,
  raw: string,
  headers: Record<string, string | undefined>,
): Promise<IntakeResult> {
  if (Buffer.byteLength(raw, 'utf8') > config.webhookMaxBytes) {
    throw new ApiError('payload_too_large', 413, `intake payload exceeds the ${config.webhookMaxBytes} byte cap`);
  }

  const body = parseBody(provider, raw);
  const source = PROVIDER_SOURCE[provider];
  const normalized = normalize(provider, body, raw);
  const sql = getSql();

  const recorded = await recordWebhookDelivery(sql, {
    provider: source,
    deliveryId: normalized.externalId,
    event: 'intake',
    action: null,
    factory,
    status: 'received',
    payload: body,
    payloadBytes: Buffer.byteLength(raw, 'utf8'),
  });
  if (recorded.duplicate) {
    return { status: 'ignored', reason: 'duplicate_delivery' };
  }

  const secret = secretFor(provider);
  if (!verifyIntakeSignature(provider, raw, headers, secret)) {
    if (recorded.delivery) {
      await markWebhookDelivery(sql, {
        id: recorded.delivery.id,
        status: 'rejected',
        reason: 'invalid_signature',
      });
    }
    throw new ApiError('invalid_signature', 401, 'intake signature verification failed', {
      provider,
    });
  }

  const created = await createWorkItemForApi(config, factory, {
    title: normalized.title,
    type: normalized.type,
    source,
    sourceRef: {
      kind: provider,
      id: normalized.externalId,
      url: normalized.url,
      untrusted: true,
    },
    prompt: normalized.prompt,
  });

  if (recorded.delivery) {
    await markWebhookDelivery(sql, {
      id: recorded.delivery.id,
      status: 'accepted',
      workItemId: created.workItem.id,
    });
  }

  return { status: 'accepted', workItem: created.workItem };
}

export function registerIntake<E extends Hono<any, any, any>>(
  app: E,
  config: ApiConfig,
  factoryOf: (c: any) => Promise<{ key: string }>,
): void {
  app.post('/factories/:factoryId/intake/:provider', async (c) => {
    const provider = c.req.param('provider') as IntakeProvider;
    if (!INTAKE_PROVIDERS.includes(provider)) {
      throw new ApiError('unsupported_provider', 404, `no intake adapter for "${provider}"`, {
        provider,
        supported: [...INTAKE_PROVIDERS],
      });
    }
    const record = await factoryOf(c);
    const raw = await c.req.text();
    const headers: Record<string, string | undefined> = {
      'x-factory-signature': c.req.header('x-factory-signature'),
      'sentry-hook-signature': c.req.header('sentry-hook-signature'),
      'x-posthog-signature': c.req.header('x-posthog-signature'),
      'linear-signature': c.req.header('linear-signature'),
      'x-jira-signature': c.req.header('x-jira-signature'),
      'x-slack-signature': c.req.header('x-slack-signature'),
      'x-slack-request-timestamp': c.req.header('x-slack-request-timestamp'),
    };
    return c.json(await intakeForApi(config, record.key, provider, raw, headers), 202);
  });

  app.get('/factories/:factoryId/intake', async (c) => {
    const record = await factoryOf(c);
    const limit = Number(c.req.query('limit') ?? '50');
    const deliveries = await listWebhookDeliveries(getSql(), {
      factory: record.key,
      limit: Number.isFinite(limit) ? limit : 50,
    });
    return c.json({
      deliveries: deliveries.filter((delivery) =>
        ['sentry', 'posthog', 'slack', 'linear', 'jira', 'api'].includes(delivery.provider),
      ),
    });
  });
}
