import { z } from 'zod';

/**
 * Canonical factory event union.
 *
 * Eleven event types, AG-UI shaped. Every adapter (opencode, fake, generic CLI, …)
 * translates its native payloads into this union so that the API, the JSONL event
 * log, the SSE stream and the UI all share one vocabulary.
 *
 * Two envelope fields are added by the producer, never by the harness:
 *   - `seq` strictly increasing per run (1, 2, 3, …), assigned by `EventSequencer`
 *   - `at`  wall-clock milliseconds (informational only; consumers must not order by it)
 */
export const FACTORY_EVENT_TYPES = [
  'run.started',
  'message.delta',
  'message.completed',
  'tool.call.started',
  'tool.call.args.delta',
  'tool.call.completed',
  'permission.requested',
  'file.edited',
  'artifact.produced',
  'usage.updated',
  'run.completed',
] as const;

export type FactoryEventType = (typeof FACTORY_EVENT_TYPES)[number];

/** JSON values only — tool args/results are persisted to JSONL, so no functions/undefined. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(jsonValueSchema),
  ]),
);

const seq = z.number().int().nonnegative();
const at = z.number().int().nonnegative();
const role = z.enum(['assistant', 'reasoning']);

export const runStartedEventSchema = z
  .object({
    type: z.literal('run.started'),
    seq,
    at,
    runId: z.string().min(1),
    harness: z.string().min(1),
    model: z.string().min(1).optional(),
  })
  .strict();

export const messageDeltaEventSchema = z
  .object({
    type: z.literal('message.delta'),
    seq,
    at,
    role,
    text: z.string(),
  })
  .strict();

export const messageCompletedEventSchema = z
  .object({
    type: z.literal('message.completed'),
    seq,
    at,
    role,
    text: z.string(),
    messageId: z.string().min(1).optional(),
  })
  .strict();

export const toolCallStartedEventSchema = z
  .object({
    type: z.literal('tool.call.started'),
    seq,
    at,
    callId: z.string().min(1),
    name: z.string().min(1),
    /** Partial args are allowed: harnesses stream arguments after the call starts. */
    args: z.record(jsonValueSchema),
  })
  .strict();

export const toolCallArgsDeltaEventSchema = z
  .object({
    type: z.literal('tool.call.args.delta'),
    seq,
    at,
    callId: z.string().min(1),
    delta: z.string(),
  })
  .strict();

export const toolCallCompletedEventSchema = z
  .object({
    type: z.literal('tool.call.completed'),
    seq,
    at,
    callId: z.string().min(1),
    result: jsonValueSchema,
    ok: z.boolean(),
  })
  .strict();

export const permissionRequestedEventSchema = z
  .object({
    type: z.literal('permission.requested'),
    seq,
    at,
    requestId: z.string().min(1),
    action: z.string().min(1),
    detail: jsonValueSchema,
  })
  .strict();

export const fileEditedEventSchema = z
  .object({
    type: z.literal('file.edited'),
    seq,
    at,
    path: z.string().min(1),
    diff: z.string(),
  })
  .strict();

export const artifactProducedEventSchema = z
  .object({
    type: z.literal('artifact.produced'),
    seq,
    at,
    path: z.string().min(1),
    kind: z.string().min(1),
    bytes: z.number().int().nonnegative().optional(),
  })
  .strict();

export const usageUpdatedEventSchema = z
  .object({
    type: z.literal('usage.updated'),
    seq,
    at,
    inputTokens: z.number().nonnegative(),
    outputTokens: z.number().nonnegative(),
    costUsd: z.number().nonnegative().optional(),
    cacheReadTokens: z.number().nonnegative().optional(),
    reasoningTokens: z.number().nonnegative().optional(),
  })
  .strict();

export const runCompletedEventSchema = z
  .object({
    type: z.literal('run.completed'),
    seq,
    at,
    status: z.enum(['ok', 'error', 'cancelled']),
    summary: z.string().optional(),
  })
  .strict();

export const factoryEventSchema = z.discriminatedUnion('type', [
  runStartedEventSchema,
  messageDeltaEventSchema,
  messageCompletedEventSchema,
  toolCallStartedEventSchema,
  toolCallArgsDeltaEventSchema,
  toolCallCompletedEventSchema,
  permissionRequestedEventSchema,
  fileEditedEventSchema,
  artifactProducedEventSchema,
  usageUpdatedEventSchema,
  runCompletedEventSchema,
]);

export type FactoryEvent = z.infer<typeof factoryEventSchema>;
export type RunStartedEvent = z.infer<typeof runStartedEventSchema>;
export type MessageDeltaEvent = z.infer<typeof messageDeltaEventSchema>;
export type MessageCompletedEvent = z.infer<typeof messageCompletedEventSchema>;
export type ToolCallStartedEvent = z.infer<typeof toolCallStartedEventSchema>;
export type ToolCallArgsDeltaEvent = z.infer<typeof toolCallArgsDeltaEventSchema>;
export type ToolCallCompletedEvent = z.infer<typeof toolCallCompletedEventSchema>;
export type PermissionRequestedEvent = z.infer<typeof permissionRequestedEventSchema>;
export type FileEditedEvent = z.infer<typeof fileEditedEventSchema>;
export type ArtifactProducedEvent = z.infer<typeof artifactProducedEventSchema>;
export type UsageUpdatedEvent = z.infer<typeof usageUpdatedEventSchema>;
export type RunCompletedEvent = z.infer<typeof runCompletedEventSchema>;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** An event as produced by an adapter, before `seq`/`at` are stamped. */
export type FactoryEventInput = DistributiveOmit<FactoryEvent, 'seq' | 'at'>;

export function isTerminalEvent(event: FactoryEvent): event is RunCompletedEvent {
  return event.type === 'run.completed';
}

export function parseFactoryEvent(value: unknown): FactoryEvent | undefined {
  const result = factoryEventSchema.safeParse(value);
  return result.success ? result.data : undefined;
}

export interface EventSequencerOptions {
  /** First assigned `seq`. Defaults to 0, so the first event gets `seq: 1`. */
  startAt?: number;
  clock?: () => number;
}

/**
 * Assigns a strictly increasing `seq` per run and stamps `at`.
 * One sequencer per run (one writer per run — see ADR "single writer per run").
 */
export class EventSequencer {
  private current: number;
  private readonly clock: () => number;

  constructor(options: EventSequencerOptions = {}) {
    this.current = options.startAt ?? 0;
    this.clock = options.clock ?? Date.now;
  }

  get lastSeq(): number {
    return this.current;
  }

  next(): number {
    this.current += 1;
    return this.current;
  }

  stamp(body: FactoryEventInput): FactoryEvent {
    return { ...body, seq: this.next(), at: this.clock() } as FactoryEvent;
  }

  stampAll(bodies: Iterable<FactoryEventInput>): FactoryEvent[] {
    return Array.from(bodies, (body) => this.stamp(body));
  }
}

export function createSequencer(options: EventSequencerOptions = {}): EventSequencer {
  return new EventSequencer(options);
}

/** Convenience for replaying a stored event log: re-stamps bodies from a start offset. */
export function assignSeq(
  bodies: Iterable<FactoryEventInput>,
  options: EventSequencerOptions = {},
): FactoryEvent[] {
  return createSequencer(options).stampAll(bodies);
}
