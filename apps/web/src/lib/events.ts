import type { FactoryEvent } from '@factory/adapters';

/**
 * The canonical event vocabulary is defined in `packages/adapters/src/events.ts`; the
 * type is imported from there so the renderer cannot drift. The *runtime* names are
 * duplicated here on purpose: importing the adapters package as a value would pull zod
 * (and node-oriented adapter code) into the browser bundle.
 */
export const EVENT_TYPES = [
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

export type StreamBlock =
  | { kind: 'notice'; id: string; seq: number; text: string; tone: 'info' | 'ok' | 'error' | 'warning' }
  | { kind: 'message'; id: string; seq: number; text: string; done: boolean }
  | {
      kind: 'tool';
      id: string;
      seq: number;
      callId: string;
      name: string;
      argsStart: string;
      argsDelta: string;
      ok: boolean | null;
      result: string | null;
    }
  | {
      kind: 'permission';
      id: string;
      seq: number;
      requestId: string;
      action: string;
      detail: unknown;
      status: 'pending' | 'allowed' | 'denied';
    }
  | { kind: 'file'; id: string; seq: number; path: string; diff: string }
  | { kind: 'artifact'; id: string; seq: number; path: string; artifactKind: string; bytes: number | null }
  | {
      kind: 'usage';
      id: string;
      seq: number;
      inputTokens: number;
      outputTokens: number;
      costUsd: number | null;
    };

export type Decisions = Record<string, 'allow' | 'deny' | 'always'>;

function decisionStatus(decision: 'allow' | 'deny' | 'always' | undefined): 'pending' | 'allowed' | 'denied' {
  if (decision === 'allow' || decision === 'always') return 'allowed';
  if (decision === 'deny') return 'denied';
  return 'pending';
}

function stringify(value: unknown, max = 400): string {
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch {
    text = String(value);
  }
  if (text === undefined) return '';
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * Deterministic projection of the append-only event log into render blocks.
 * Pure and order-preserving: the UI never re-sorts, it only appends.
 */
export function reduceEvents(events: FactoryEvent[], decisions: Decisions = {}): StreamBlock[] {
  const blocks: StreamBlock[] = [];
  const seen = new Set<number>();
  const toolsByCall = new Map<string, Extract<StreamBlock, { kind: 'tool' }>>();

  for (const event of events) {
    if (typeof event.seq === 'number') {
      if (seen.has(event.seq)) continue;
      seen.add(event.seq);
    }
    const id = `seq-${event.seq}`;

    switch (event.type) {
      case 'run.started': {
        blocks.push({
          kind: 'notice',
          id,
          seq: event.seq,
          text: `Run started · ${event.harness}${event.model ? ` · ${event.model}` : ''}`,
          tone: 'info',
        });
        break;
      }

      case 'message.delta': {
        const last = blocks[blocks.length - 1];
        if (last && last.kind === 'message' && !last.done) {
          last.text += event.text;
        } else {
          blocks.push({ kind: 'message', id, seq: event.seq, text: event.text, done: false });
        }
        break;
      }

      case 'message.completed': {
        const last = blocks[blocks.length - 1];
        if (last && last.kind === 'message' && !last.done) {
          last.text = event.text;
          last.done = true;
        } else {
          blocks.push({ kind: 'message', id, seq: event.seq, text: event.text, done: true });
        }
        break;
      }

      case 'tool.call.started': {
        const block: Extract<StreamBlock, { kind: 'tool' }> = {
          kind: 'tool',
          id,
          seq: event.seq,
          callId: event.callId,
          name: event.name,
          argsStart: stringify(event.args),
          argsDelta: '',
          ok: null,
          result: null,
        };
        blocks.push(block);
        toolsByCall.set(event.callId, block);
        break;
      }

      case 'tool.call.args.delta': {
        const tool = toolsByCall.get(event.callId);
        if (tool) tool.argsDelta += event.delta;
        break;
      }

      case 'tool.call.completed': {
        const tool = toolsByCall.get(event.callId);
        if (tool) {
          tool.ok = event.ok;
          tool.result = stringify(event.result);
        }
        break;
      }

      case 'permission.requested': {
        blocks.push({
          kind: 'permission',
          id,
          seq: event.seq,
          requestId: event.requestId,
          action: event.action,
          detail: event.detail,
          status: decisionStatus(decisions[event.requestId]),
        });
        break;
      }

      case 'file.edited': {
        blocks.push({ kind: 'file', id, seq: event.seq, path: event.path, diff: event.diff });
        break;
      }

      case 'artifact.produced': {
        blocks.push({
          kind: 'artifact',
          id,
          seq: event.seq,
          path: event.path,
          artifactKind: event.kind,
          bytes: event.bytes ?? null,
        });
        break;
      }

      case 'usage.updated': {
        blocks.push({
          kind: 'usage',
          id,
          seq: event.seq,
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens,
          costUsd: event.costUsd ?? null,
        });
        break;
      }

      case 'run.completed': {
        blocks.push({
          kind: 'notice',
          id,
          seq: event.seq,
          text: `Run completed · ${event.status}${event.summary ? ` · ${event.summary}` : ''}`,
          tone: event.status === 'ok' ? 'ok' : event.status === 'error' ? 'error' : 'warning',
        });
        break;
      }

      default:
        break;
    }
  }

  return blocks;
}

/** Decisions map from the persisted permission rows (so a reload keeps resolved prompts). */
export function decisionsFromPermissions(
  permissions: { request_id: string; decision: 'allow' | 'deny' | 'always' | null }[],
): Decisions {
  const decisions: Decisions = {};
  for (const permission of permissions) {
    if (permission.decision) decisions[permission.request_id] = permission.decision;
  }
  return decisions;
}

export function terminalEvent(events: FactoryEvent[]): Extract<FactoryEvent, { type: 'run.completed' }> | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event && event.type === 'run.completed') return event;
  }
  return null;
}
