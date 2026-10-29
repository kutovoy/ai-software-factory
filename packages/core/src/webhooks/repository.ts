import type { SQL } from 'bun';

/**
 * Webhook delivery log (Phase 3b, ADR-023). Webhooks are untrusted input: the row records
 * the verified delivery, the decision (`accepted` / `ignored` / `rejected`) and — when one
 * was created — the work item. `(provider, delivery_id)` is the idempotency key, so a
 * redelivered GitHub event is acknowledged and ignored.
 */

export const WEBHOOK_DELIVERY_STATUSES = ['received', 'accepted', 'ignored', 'rejected'] as const;
export type WebhookDeliveryStatus = (typeof WEBHOOK_DELIVERY_STATUSES)[number];

export interface WebhookDeliveryRecord {
  id: number;
  provider: string;
  deliveryId: string;
  event: string | null;
  action: string | null;
  factory: string | null;
  status: WebhookDeliveryStatus;
  reason: string | null;
  workItemId: string | null;
  sender: string | null;
  payload: Record<string, unknown>;
  payloadBytes: number;
  createdAt: string | null;
}

interface DeliveryRow {
  id: number | string;
  provider: string;
  delivery_id: string;
  event: string | null;
  action: string | null;
  factory: string | null;
  status: string;
  reason: string | null;
  work_item_id: string | null;
  sender: string | null;
  payload: unknown;
  payload_bytes: number | string;
  created_at: unknown;
}

function parseJsonb<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value as T;
}

function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function map(row: DeliveryRow): WebhookDeliveryRecord {
  return {
    id: Number(row.id),
    provider: row.provider,
    deliveryId: row.delivery_id,
    event: row.event,
    action: row.action,
    factory: row.factory,
    status: row.status as WebhookDeliveryStatus,
    reason: row.reason,
    workItemId: row.work_item_id,
    sender: row.sender,
    payload: parseJsonb<Record<string, unknown>>(row.payload, {}),
    payloadBytes: Number(row.payload_bytes),
    createdAt: iso(row.created_at),
  };
}

export interface RecordWebhookDeliveryArgs {
  provider: string;
  deliveryId: string;
  event?: string | null;
  action?: string | null;
  factory?: string | null;
  status: WebhookDeliveryStatus;
  reason?: string | null;
  workItemId?: string | null;
  sender?: string | null;
  payload?: Record<string, unknown>;
  payloadBytes?: number;
}

/**
 * Records a delivery. Returns `duplicate: true` when this `(provider, delivery_id)` was
 * already seen — the caller then acknowledges and ignores it (spec: delivery dedupe).
 */
export async function recordWebhookDelivery(
  sql: SQL,
  args: RecordWebhookDeliveryArgs,
): Promise<{ delivery: WebhookDeliveryRecord | null; duplicate: boolean }> {
  const rows = (await sql`
    insert into webhook_deliveries (
      provider, delivery_id, event, action, factory, status, reason, work_item_id, sender,
      payload, payload_bytes
    ) values (
      ${args.provider}, ${args.deliveryId}, ${args.event ?? null}, ${args.action ?? null},
      ${args.factory ?? null}, ${args.status}, ${args.reason ?? null},
      ${args.workItemId ?? null}, ${args.sender ?? null},
      ${JSON.stringify(args.payload ?? {})}::jsonb, ${args.payloadBytes ?? 0}
    )
    on conflict (provider, delivery_id) do nothing
    returning *
  `) as DeliveryRow[];

  if (rows[0]) return { delivery: map(rows[0]), duplicate: false };
  return { delivery: null, duplicate: true };
}

export async function getWebhookDelivery(
  sql: SQL,
  provider: string,
  deliveryId: string,
): Promise<WebhookDeliveryRecord | null> {
  const rows = (await sql`
    select * from webhook_deliveries
    where provider = ${provider} and delivery_id = ${deliveryId}
    limit 1
  `) as DeliveryRow[];
  return rows[0] ? map(rows[0]) : null;
}

export async function markWebhookDelivery(
  sql: SQL,
  args: {
    id: number;
    status: WebhookDeliveryStatus;
    reason?: string | null;
    workItemId?: string | null;
    factory?: string | null;
  },
): Promise<WebhookDeliveryRecord | null> {
  const rows = (await sql`
    update webhook_deliveries set
      status = ${args.status},
      reason = coalesce(${args.reason ?? null}, reason),
      work_item_id = coalesce(${args.workItemId ?? null}, work_item_id),
      factory = coalesce(${args.factory ?? null}, factory)
    where id = ${args.id}
    returning *
  `) as DeliveryRow[];
  return rows[0] ? map(rows[0]) : null;
}

export async function listWebhookDeliveries(
  sql: SQL,
  filters: { factory?: string; provider?: string; limit?: number } = {},
): Promise<WebhookDeliveryRecord[]> {
  const factory = filters.factory ?? null;
  const provider = filters.provider ?? null;
  const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);
  const rows = (await sql`
    select * from webhook_deliveries
    where (${factory}::text is null or factory = ${factory})
      and (${provider}::text is null or provider = ${provider})
    order by created_at desc
    limit ${limit}
  `) as DeliveryRow[];
  return rows.map(map);
}
