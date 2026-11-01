import type {
  AdapterCapabilities,
  AgentDescriptor,
  FileDiff,
  HarnessAdapter,
  PermissionDecision,
  PromptOptions,
  PromptPart,
  SessionHandle,
  StartSessionRequest,
  UsageReport,
  AdapterStats,
} from './adapter';
import { AdapterError } from './errors';
import {
  createSequencer,
  type EventSequencer,
  type FactoryEvent,
  type FactoryEventInput,
  type JsonValue,
  type PermissionRequestedEvent,
} from './events';
import { canonicalMcpCapabilityRecord } from './mcp';

export interface FakeAdapterOptions {
  /** Delay between scripted steps. Defaults to 0 so tests run instantly. */
  delayMs?: number;
  /** Model reported in `run.started`; defaults to `fake/fake-model`. */
  model?: string;
  /**
   * Terminal `run.completed` summary. Test seam for contracts that read the summary (agent
   * gate verdicts); omitted by default so the scripted happy path stays unchanged.
   */
  summary?: string;
  /** Clock used to stamp `at`; injectable for deterministic logs. */
  clock?: () => number;
}

type ScriptStep =
  | { kind: 'emit'; body: FactoryEventInput }
  | {
      kind: 'permission';
      request: Omit<PermissionRequestedEvent, 'seq' | 'at'>;
      onAllow: FactoryEventInput[];
      onDeny: FactoryEventInput[];
    };

/**
 * Deterministic scripted adapter.
 *
 * Emits the canonical happy path — run.started → message deltas → two tool calls
 * (the second one gated on an interactive permission) → file.edited → usage.updated →
 * run.completed(ok) — so CI, smoke tests and the UI can exercise the whole pipeline
 * with no model, no network and no credentials.
 *
 * The script deliberately mirrors `test/fixtures/opencode-run.sse`; the contract test
 * asserts both adapters produce the same canonical sequence.
 */
export class FakeAdapter implements HarnessAdapter {
  readonly id = 'fake' as const;

  readonly capabilities: AdapterCapabilities = {
    streaming: true,
    toolCalls: true,
    permissions: 'interactive',
    resume: false,
    fork: false,
    usage: true,
    structuredOutput: true,
    // The scripted adapter hosts no MCP servers; the request is recorded on the handle.
    mcp: false,
  };

  private readonly delayMs: number;
  private readonly model: string;
  private readonly summary: string | undefined;
  private readonly clock: () => number;
  private readonly handles = new Map<string, SessionHandle>();
  private readonly sequencers = new Map<string, EventSequencer>();
  private readonly prompts = new Map<string, string>();
  private readonly decisions = new Map<string, (decision: PermissionDecision) => void>();
  private readonly cancelled = new Set<string>();
  private emitted = 0;
  private dropped = 0;

  constructor(options: FakeAdapterOptions = {}) {
    this.delayMs = Math.max(0, options.delayMs ?? 0);
    this.model = options.model ?? 'fake/fake-model';
    this.summary = options.summary;
    this.clock = options.clock ?? Date.now;
  }

  async startSession(req: StartSessionRequest): Promise<SessionHandle> {
    const handle: SessionHandle = {
      adapterId: this.id,
      runId: req.runId,
      sessionRef: `fake-${req.runId}`,
      model: req.model ?? this.model,
      // No MCP support: record the requested wiring as canonical capability flags
      // (spec `mcp-integration`: map + record, best effort).
      ...(req.mcp
        ? {
            meta: {
              mcp: {
                ...canonicalMcpCapabilityRecord(req.mcp),
              } as unknown as JsonValue,
            },
          }
        : {}),
    };
    this.handles.set(req.runId, handle);
    this.sequencers.set(req.runId, createSequencer({ clock: this.clock }));
    this.cancelled.delete(req.runId);
    return handle;
  }

  async sendPrompt(
    handle: SessionHandle,
    parts: PromptPart[],
    opts: PromptOptions = {},
  ): Promise<void> {
    this.requireHandle(handle);
    if (opts.structuredOutput && !this.capabilities.structuredOutput) {
      throw new AdapterError('unsupported_capability', 'structured output is not supported');
    }
    const text = parts
      .filter((part): part is Extract<PromptPart, { type: 'text' }> => part.type === 'text')
      .map((part) => part.text)
      .join('\n');
    this.prompts.set(handle.runId, text);
  }

  async *streamEvents(handle: SessionHandle, signal?: AbortSignal): AsyncIterable<FactoryEvent> {
    this.requireHandle(handle);
    const sequencer = this.sequencers.get(handle.runId)!;
    const runId = handle.runId;

    const emit = (body: FactoryEventInput): FactoryEvent => {
      const event = sequencer.stamp(body);
      this.emitted += 1;
      return event;
    };

    yield emit({
      type: 'run.started',
      runId,
      harness: this.id,
      model: handle.model ?? this.model,
    });

    for (const step of this.script(runId)) {
      if (this.cancelled.has(runId) || signal?.aborted) {
        yield emit({ type: 'run.completed', status: 'cancelled', summary: 'cancelled' });
        return;
      }

      if (step.kind === 'emit') {
        await this.sleep(signal);
        yield emit(step.body);
        continue;
      }

      await this.sleep(signal);
      // Register the waiter before announcing the request: consumers answer synchronously
      // from the event loop, so the resolver must already be in place.
      const pending = this.prepareDecision(runId, signal);
      yield emit(step.request);

      const decision = await pending;
      if (decision === undefined) {
        yield emit({ type: 'run.completed', status: 'cancelled', summary: 'cancelled' });
        return;
      }

      const followUp = decision === 'deny' ? step.onDeny : step.onAllow;
      for (const body of followUp) {
        await this.sleep(signal);
        yield emit(body);
      }
    }
  }

  async cancel(handle: SessionHandle, reason?: string): Promise<void> {
    this.requireHandle(handle);
    this.cancelled.add(handle.runId);
    const resolve = this.decisions.get(handle.runId);
    if (resolve) {
      this.decisions.delete(handle.runId);
      resolve('deny');
    }
    void reason;
  }

  async resume(_handle: SessionHandle, _sessionRef?: string): Promise<SessionHandle> {
    throw new AdapterError(
      'unsupported_capability',
      'fake adapter does not support resume; start a fresh session',
      { capability: 'resume' },
    );
  }

  async respondToPermission(
    handle: SessionHandle,
    requestId: string,
    decision: PermissionDecision,
  ): Promise<void> {
    this.requireHandle(handle);
    const resolve = this.decisions.get(handle.runId);
    if (!resolve) {
      throw new AdapterError('permission_not_found', `no pending permission ${requestId}`, {
        requestId,
      });
    }
    this.decisions.delete(handle.runId);
    resolve(decision);
  }

  async listAgents(_handle: SessionHandle): Promise<AgentDescriptor[]> {
    return [
      { id: 'build', name: 'Build', mode: 'primary', description: 'Implements changes' },
      { id: 'explore', name: 'Explore', mode: 'subagent', description: 'Reads the codebase' },
    ];
  }

  async getDiff(_handle: SessionHandle): Promise<FileDiff[]> {
    return [
      {
        path: 'README.md',
        diff: '@@ -1 +1 @@\n-# Factory\n+# Factory\n',
        status: 'modified',
        additions: 1,
        deletions: 1,
      },
    ];
  }

  async getUsage(_handle: SessionHandle): Promise<UsageReport> {
    return { inputTokens: 1200, outputTokens: 80, costUsd: 0.0021, cacheReadTokens: 0 };
  }

  async dispose(handle: SessionHandle): Promise<void> {
    this.handles.delete(handle.runId);
    this.sequencers.delete(handle.runId);
    this.prompts.delete(handle.runId);
    this.cancelled.delete(handle.runId);
    this.decisions.delete(handle.runId);
  }

  getStats(): AdapterStats {
    return { droppedEvents: this.dropped, emittedEvents: this.emitted };
  }

  private requireHandle(handle: SessionHandle): void {
    if (!this.handles.has(handle.runId)) {
      throw new AdapterError('session_not_found', `unknown fake session ${handle.runId}`, {
        runId: handle.runId,
      });
    }
  }

  private prepareDecision(
    runId: string,
    signal?: AbortSignal,
  ): Promise<PermissionDecision | undefined> {
    if (this.cancelled.has(runId) || signal?.aborted) return Promise.resolve(undefined);
    return new Promise<PermissionDecision | undefined>((resolve) => {
      this.decisions.set(runId, (decision) => resolve(decision));
      if (signal) {
        signal.addEventListener(
          'abort',
          () => {
            if (this.decisions.delete(runId)) resolve(undefined);
          },
          { once: true },
        );
      }
    });
  }

  private async sleep(signal?: AbortSignal): Promise<void> {
    if (this.delayMs === 0) return;
    if (signal?.aborted) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, this.delayMs);
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }

  /** The scripted happy path. Kept as a function so each run gets fresh payload objects. */
  private script(runId: string): ScriptStep[] {
    void runId;
    return [
      { kind: 'emit', body: { type: 'message.delta', role: 'assistant', text: 'Read' } },
      { kind: 'emit', body: { type: 'message.delta', role: 'assistant', text: 'ing file.' } },
      {
        kind: 'emit',
        body: { type: 'message.completed', role: 'assistant', text: 'Reading file.' },
      },
      {
        kind: 'emit',
        body: {
          type: 'tool.call.started',
          callId: 'call_1',
          name: 'read_file',
          args: {},
        },
      },
      {
        kind: 'emit',
        body: { type: 'tool.call.args.delta', callId: 'call_1', delta: '{"path":"README.md"}' },
      },
      {
        kind: 'emit',
        body: {
          type: 'tool.call.completed',
          callId: 'call_1',
          result: { structured: {}, content: [{ type: 'text', text: '# Factory' }] },
          ok: true,
        },
      },
      {
        kind: 'emit',
        body: { type: 'tool.call.started', callId: 'call_2', name: 'bash', args: {} },
      },
      {
        kind: 'emit',
        body: { type: 'tool.call.args.delta', callId: 'call_2', delta: '{"command":"ls -la"}' },
      },
      {
        kind: 'permission',
        request: {
          type: 'permission.requested',
          requestId: 'per_1',
          action: 'bash',
          detail: { resources: ['ls -la'] },
        },
        onAllow: [
          {
            type: 'tool.call.completed',
            callId: 'call_2',
            result: { structured: {}, content: [{ type: 'text', text: 'total 0' }] },
            ok: true,
          },
        ],
        onDeny: [
          {
            type: 'tool.call.completed',
            callId: 'call_2',
            result: { error: { message: 'permission denied' } },
            ok: false,
          },
        ],
      },
      {
        kind: 'emit',
        body: {
          type: 'file.edited',
          path: 'README.md',
          diff: '@@ -1 +1 @@\n-# Factory\n+# Factory\n',
        },
      },
      {
        kind: 'emit',
        body: {
          type: 'usage.updated',
          inputTokens: 1200,
          outputTokens: 80,
          costUsd: 0.0021,
          cacheReadTokens: 0,
          reasoningTokens: 0,
        },
      },
      { kind: 'emit', body: { type: 'run.completed', status: 'ok', ...(this.summary ? { summary: this.summary } : {}) } },
    ];
  }
}
