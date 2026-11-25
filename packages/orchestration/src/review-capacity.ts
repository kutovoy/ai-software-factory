import {
  DEFAULT_REVIEW_CAPACITY,
  emptyComprehensionMetrics,
  evaluateReviewCapacity,
  type ComprehensionMetrics,
  type ResolvedReviewCapacity,
  type ReviewCapacityStatus,
} from '@factory/core';
import { getSql } from './db';

/**
 * Review-capacity and comprehension projections (change
 * `add-review-capacity-and-compounding`).
 *
 * Pure derivations from the existing read model: pending `gate_decisions` joined to
 * `work_items`, plus the newest `review.packet` payload per work item. No migration, no
 * new table, no model call. The event log remains the source of truth.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Diff lines in one review-packet payload. Prefers the measured `slopActual.diffLines`
 * and falls back to `diffStats.additions + diffStats.deletions`; anything missing is 0.
 */
export function reviewPacketDiffLines(payload: unknown): number {
  if (!isRecord(payload)) return 0;
  const slop = isRecord(payload.slopActual) ? payload.slopActual : null;
  const slopLines = slop ? finite(slop.diffLines) : null;
  if (slopLines !== null && slopLines >= 0) return Math.floor(slopLines);

  const stats = isRecord(payload.diffStats) ? payload.diffStats : null;
  if (!stats) return 0;
  const additions = finite(stats.additions);
  const deletions = finite(stats.deletions);
  if (additions === null || deletions === null) return 0;
  return Math.max(0, Math.floor(additions + deletions));
}

/**
 * Distinct top-level path segments touched by a review packet (`blastRadius.paths`).
 * Missing or malformed paths contribute nothing.
 */
export function reviewPacketTopLevelPaths(payload: unknown): string[] {
  if (!isRecord(payload)) return [];
  const blastRadius = isRecord(payload.blastRadius) ? payload.blastRadius : null;
  const paths = blastRadius && Array.isArray(blastRadius.paths) ? blastRadius.paths : [];
  const segments = new Set<string>();
  for (const path of paths) {
    if (typeof path !== 'string' || path.trim().length === 0) continue;
    const normalized = path.replaceAll('\\', '/').replace(/^\/+/, '');
    const segment = normalized.split('/')[0];
    if (segment && segment.length > 0) segments.add(segment);
  }
  return [...segments];
}

function toMs(value: unknown): number | null {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

/** Age in hours of the oldest gate; 0 when nothing is pending or timestamps are invalid. */
export function oldestGateHoursFrom(
  requestedAtValues: ReadonlyArray<unknown>,
  nowMs: number = Date.now(),
): number {
  let oldest: number | null = null;
  for (const value of requestedAtValues) {
    const ms = toMs(value);
    if (ms === null) continue;
    if (oldest === null || ms < oldest) oldest = ms;
  }
  if (oldest === null) return 0;
  return Math.max(0, (nowMs - oldest) / (60 * 60 * 1000));
}

/**
 * Stable refusal reason for plan auto-approval / autonomy enablement. The API and the
 * mission activity both report the same string so the audit trail stays consistent.
 */
export function reviewCapacityRefusalReason(status: ReviewCapacityStatus): string {
  const detail =
    status.reasons.length > 0 ? status.reasons.join('; ') : 'review capacity saturated';
  return `review_capacity_exceeded: ${detail}`;
}

interface PendingGateRow {
  work_item_id: string;
  requested_at: unknown;
}

interface PacketRow {
  work_item_id: string;
  payload: unknown;
}

/**
 * Current review pressure for a factory: pending gates, the unread diff volume of their
 * newest review packets and the age of the oldest gate. Caps default to
 * `DEFAULT_REVIEW_CAPACITY`. A factory with no pending gates reports zeroes, never an
 * error.
 */
export async function reviewCapacityForFactory(
  factory: string,
  config: ResolvedReviewCapacity = DEFAULT_REVIEW_CAPACITY,
): Promise<ReviewCapacityStatus> {
  const sql = getSql();

  const pending = (await sql`
    select g.work_item_id, g.requested_at
    from gate_decisions g
    join work_items w on w.id = g.work_item_id
    where w.factory = ${factory} and g.decision is null
    order by g.requested_at asc
  `) as PendingGateRow[];

  const workItemIds: string[] = [];
  for (const row of pending) {
    if (typeof row.work_item_id === 'string' && !workItemIds.includes(row.work_item_id)) {
      workItemIds.push(row.work_item_id);
    }
  }

  let unreadDiffLines = 0;
  for (const workItemId of workItemIds) {
    const packets = (await sql`
      select payload from work_item_events
      where work_item_id = ${workItemId} and type = 'review.packet'
      order by id desc
      limit 1
    `) as Array<{ payload: unknown }>;
    unreadDiffLines += reviewPacketDiffLines(packets[0]?.payload);
  }

  return evaluateReviewCapacity(
    {
      openGates: pending.length,
      unreadDiffLines,
      oldestGateHours: oldestGateHoursFrom(pending.map((row) => row.requested_at)),
    },
    config,
  );
}

/**
 * Honest comprehension proxies for a factory. Counts only items with a review packet,
 * excludes cancelled items and treats a gate decision as human review only when it was
 * recorded by a human (`automatic = false`). Missing rows yield zeroes; malformed packet
 * payloads contribute nothing.
 */
export async function comprehensionForFactory(
  factory: string,
): Promise<ComprehensionMetrics> {
  try {
    const sql = getSql();

    const packets = (await sql`
      select distinct on (e.work_item_id) e.work_item_id, e.payload
      from work_item_events e
      join work_items w on w.id = e.work_item_id
      where w.factory = ${factory}
        and e.type = 'review.packet'
        and w.status <> 'cancelled'
      order by e.work_item_id, e.id desc
    `) as PacketRow[];

    if (packets.length === 0) return emptyComprehensionMetrics();

    const humanRows = (await sql`
      select distinct g.work_item_id
      from gate_decisions g
      join work_items w on w.id = g.work_item_id
      where w.factory = ${factory}
        and g.decision is not null
        and g.automatic = false
    `) as Array<{ work_item_id: string }>;
    const humanReviewed = new Set(
      humanRows
        .map((row) => row.work_item_id)
        .filter((id): id is string => typeof id === 'string'),
    );

    let unreadDiffLines = 0;
    let itemsWithoutHumanReview = 0;
    const modules = new Set<string>();

    for (const packet of packets) {
      if (humanReviewed.has(packet.work_item_id)) continue;
      itemsWithoutHumanReview += 1;
      unreadDiffLines += reviewPacketDiffLines(packet.payload);
      for (const segment of reviewPacketTopLevelPaths(packet.payload)) modules.add(segment);
    }

    const reviewed = packets.filter((packet) => humanReviewed.has(packet.work_item_id)).length;
    const reviewCoveragePercent =
      packets.length > 0 ? Math.round((reviewed / packets.length) * 1000) / 10 : 0;

    return {
      unreadDiffLines,
      itemsWithoutHumanReview,
      modulesWithoutHumanTouch: modules.size,
      reviewCoveragePercent,
    };
  } catch {
    // Missing rows, malformed payloads or a read-model gap must not break the read path.
    return emptyComprehensionMetrics();
  }
}
