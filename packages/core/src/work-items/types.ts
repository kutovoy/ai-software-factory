import { z } from 'zod';
import { codedString } from '../schema/common';
import { LOOP_STAGES } from '../stage-graph/graph';

/**
 * A work item is a persisted record, not a workflow variable (design decision 1): it has a
 * stable `wi_<ulid>` id, a type, source context (enough to reply to the original
 * thread/issue), lineage (`parentId`) and a current stage. The workflow id is derived from
 * the id, so a worker restart reattaches to the same item.
 */

export const WORK_ITEM_TYPES = ['task', 'bug', 'incident', 'pr_review'] as const;
export type WorkItemType = (typeof WORK_ITEM_TYPES)[number];

export const WORK_ITEM_SOURCES = ['forge', 'slack', 'cron', 'manual'] as const;
export type WorkItemSource = (typeof WORK_ITEM_SOURCES)[number];

export const WORK_ITEM_STATUSES = ['active', 'blocked', 'escalated', 'done', 'cancelled'] as const;
export type WorkItemStatus = (typeof WORK_ITEM_STATUSES)[number];

/**
 * Statuses a work item may be retried from (spec `factory-loop` › Work-item retry).
 *
 * `failed` is accepted for forward compatibility: no writer produces it today (a stage run
 * that fails escalates the item), but an item recorded as `failed` by an external producer
 * must still be recoverable. `active` and `done` are never retryable.
 */
export const RETRYABLE_WORK_ITEM_STATUSES = [
  'escalated',
  'failed',
  'blocked',
  'cancelled',
] as const;
export type RetryableWorkItemStatus = (typeof RETRYABLE_WORK_ITEM_STATUSES)[number];

export function isRetryableWorkItemStatus(status: string): status is RetryableWorkItemStatus {
  return (RETRYABLE_WORK_ITEM_STATUSES as readonly string[]).includes(status);
}

/** Which factory version a work item ran (canary routing, ADR-021). */
export const WORK_ITEM_VERSIONS = ['stable', 'candidate'] as const;
export type WorkItemVersion = (typeof WORK_ITEM_VERSIONS)[number];

export const GATE_DECISIONS = ['approve', 'reject', 'request_changes'] as const;
export type GateDecisionValue = (typeof GATE_DECISIONS)[number];

/** `wi_` + a 26-character Crockford base32 ULID. */
export const WORK_ITEM_ID_RE = /^wi_[0-9A-HJKMNP-TV-Z]{26}$/;

export const FACTORY_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;

export const workItemSchema = z
  .object({
    id: codedString(WORK_ITEM_ID_RE, 'invalid_value', 'work item id must be wi_<ulid>'),
    type: z.enum(WORK_ITEM_TYPES),
    source: z.enum(WORK_ITEM_SOURCES),
    /** Enough to reply to the original thread/issue (e.g. `{kind, id, url, channel}`). */
    sourceRef: z.record(z.string(), z.unknown()).default({}),
    title: z.string().min(1).max(200),
    stage: z.enum(LOOP_STAGES),
    status: z.enum(WORK_ITEM_STATUSES).default('active'),
    parentId: z.string().regex(WORK_ITEM_ID_RE).nullable().default(null),
    factory: codedString(FACTORY_NAME_RE, 'invalid_value', 'invalid factory name'),
    definitionCommit: z.string().min(7),
    /**
     * Canary routing (ADR-021): assigned once at creation and honoured by every stage of
     * this item. `null` when no rollout was active.
     */
    canaryRolloutId: z.string().min(1).nullable().default(null),
    definitionVersion: z.enum(WORK_ITEM_VERSIONS).default('stable'),
    /** True when the pinned definition was dirty at creation (the commit is the identity). */
    definitionDirty: z.boolean().default(false),
    /**
     * Opaque creation snapshot (stage order, gates, resolved run defaults). A retry reuses
     * it so the item keeps the harness/model/runner it was created with.
     */
    input: z.record(z.string(), z.unknown()).default({}),
    prUrl: z.string().url().nullable().default(null),
    prNumber: z.number().int().min(1).nullable().default(null),
    loopCount: z.number().int().min(0).default(0),
    /**
     * Attempt counter (1-based): 1 for the first dispatch, incremented by every retry. The
     * live workflow id is `factory-<id>` for attempt 1 and `factory-<id>-a<n>` afterwards.
     */
    attempt: z.number().int().min(1).default(1),
    /** When the item was last retried (the newest `work_item.retried` event), else null. */
    retriedAt: z.string().nullable().default(null),
    /** The workflow currently driving the item (null until it is first started). */
    workflowId: z.string().nullable().default(null),
    /**
     * Cooperative cancellation (harden-runtime). The request is recorded once; the
     * workflow cancels the in-flight stage child and ends `cancelled`.
     */
    cancelRequestedAt: z.string().nullable().default(null),
    cancelActor: z.string().nullable().default(null),
    cancelReason: z.string().nullable().default(null),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
  })
  .strict();

export type WorkItem = z.infer<typeof workItemSchema>;

export const createWorkItemSchema = z
  .object({
    factory: codedString(FACTORY_NAME_RE, 'invalid_value', 'invalid factory name'),
    title: z.string().min(1).max(200),
    type: z.enum(WORK_ITEM_TYPES).default('task'),
    source: z.enum(WORK_ITEM_SOURCES).default('manual'),
    sourceRef: z.record(z.string(), z.unknown()).default({}),
    parentId: z.string().regex(WORK_ITEM_ID_RE).optional(),
    definitionCommit: z.string().min(7),
    /** Defaults to the first stage of the compiled graph. */
    stage: z.enum(LOOP_STAGES).optional(),
  })
  .strict();

export type NewWorkItem = z.infer<typeof createWorkItemSchema>;

export const gateDecisionRequestSchema = z
  .object({
    decision: z.enum(GATE_DECISIONS),
    actor: z.string().min(1).max(120),
    reason: z.string().max(2000).optional(),
    feedback: z.string().max(4000).optional(),
  })
  .strict();

export type GateDecisionRequest = z.infer<typeof gateDecisionRequestSchema>;

export const autonomyOverrideSchema = z
  .object({ actor: z.string().min(1).max(120), reason: z.string().min(1).max(2000) })
  .strict();

export const autonomyRequestSchema = z
  .object({
    factory: codedString(FACTORY_NAME_RE, 'invalid_value', 'invalid factory name'),
    enabled: z.boolean(),
    actor: z.string().min(1).max(120),
    reason: z.string().min(1).max(2000),
    override: autonomyOverrideSchema.optional(),
  })
  .strict();

export type AutonomyRequestInput = z.infer<typeof autonomyRequestSchema>;

/** Event types written to `work_item_events`. Kept as a union so the UI can branch on them. */
export const WORK_ITEM_EVENT_TYPES = [
  'work_item.created',
  'stage.changed',
  'dispatch.requested',
  'dispatch.denied',
  'judgement.call',
  'judgement.escalated',
  'gate.requested',
  'gate.decided',
  'gate.escalated',
  'review.verdict',
  'pr.opened',
  'checks.recorded',
  'loop.requested_changes',
  'loop.escalated',
  'autonomy.paused',
  'autonomy.enabled',
  'autonomy.refused',
  /** An automation could not satisfy the benchmark attestation; it runs with human gates. */
  'autonomy.attestation_missing',
  'cancel.requested',
  'work_item.cancelled',
  /** A terminal item was re-opened and its current stage dispatched under a new attempt. */
  'work_item.retried',
  'runner.sandbox_unavailable',
  'work_item.status',
  'work_item.spawned',
] as const;
export type WorkItemEventType = (typeof WORK_ITEM_EVENT_TYPES)[number];
