import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type {
  AdapterCapabilities,
  AdapterStats,
  AgentDescriptor,
  FileDiff,
  HarnessAdapter,
  PermissionDecision,
  PromptOptions,
  PromptPart,
  SessionHandle,
  StartSessionRequest,
  UsageReport,
} from './adapter';
import { AdapterError } from './errors';
import {
  createSequencer,
  isTerminalEvent,
  parseFactoryEvent,
  type EventSequencer,
  type FactoryEvent,
  type FactoryEventInput,
  type JsonValue,
  type RunStartedEvent,
  type UsageUpdatedEvent,
} from './events';

export interface ReplayAdapterOptions {
  /** The recording directory (`runs/<runId>`) holding `events.jsonl` + `patch.diff`. */
  recordingDir: string;
  /** Workspace the recorded patch is applied to (a fresh checkout). */
  workspace?: string;
  /** Clock used to stamp `at`; injectable for deterministic logs. */
  clock?: () => number;
  /** Test hook: apply the patch with this function instead of `git apply`. */
  applyPatch?: (patchPath: string, workspace: string) => void;
}

interface ReplaySession {
  handle: SessionHandle;
  events: FactoryEvent[];
  patch: string;
  workspace: string | null;
  sequencer: EventSequencer;
  cancelled: boolean;
}

/** Applies a recorded unified diff to the workspace with `git apply`. */
function applyPatchWithGit(patchPath: string, workspace: string): void {
  const result = spawnSync('git', ['apply', '--whitespace=nowarn', patchPath], {
    cwd: workspace,
    encoding: 'utf8',
  });
  if (result.error || result.status !== 0) {
    const detail = (result.stderr ?? '').trim() || result.error?.message || 'unknown error';
    throw new AdapterError(
      'replay_apply_failed',
      `cannot apply ${patchPath} to ${workspace}: ${detail}`,
      { patchPath, workspace },
    );
  }
}

/**
 * Recorded-run replay (spec `benchmark-replay`).
 *
 * A replay is *not* a harness simulation: it reads `runs/<id>/events.jsonl` + `patch.diff`,
 * re-emits the recorded canonical event stream (with fresh `seq`/`at`, so it is a normal run
 * from the API's point of view) and applies the recorded patch to a fresh workspace. A
 * benchmark trial can therefore be scored deterministically with no model call.
 *
 * Missing recording → `replay_missing`; a patch that does not apply → `replay_apply_failed`.
 */
export class ReplayAdapter implements HarnessAdapter {
  readonly id = 'replay' as const;

  readonly capabilities: AdapterCapabilities = {
    streaming: true,
    toolCalls: true,
    // Recorded decisions are already baked into the stream; nothing waits on a human.
    permissions: 'none',
    resume: false,
    fork: false,
    usage: true,
    structuredOutput: false,
    mcp: false,
  };

  private readonly recordingDir: string;
  private readonly workspace: string | undefined;
  private readonly clock: () => number;
  private readonly applyPatch: (patchPath: string, workspace: string) => void;
  private readonly sessions = new Map<string, ReplaySession>();
  private emitted = 0;

  constructor(options: ReplayAdapterOptions) {
    this.recordingDir = options.recordingDir;
    this.workspace = options.workspace;
    this.clock = options.clock ?? Date.now;
    this.applyPatch = options.applyPatch ?? applyPatchWithGit;
  }

  async startSession(req: StartSessionRequest): Promise<SessionHandle> {
    const eventsPath = join(this.recordingDir, 'events.jsonl');
    const patchPath = join(this.recordingDir, 'patch.diff');
    const hasEvents = existsSync(eventsPath);
    const hasPatch = existsSync(patchPath);
    if (!hasEvents || !hasPatch) {
      throw new AdapterError(
        'replay_missing',
        `recording ${this.recordingDir} is incomplete: needs events.jsonl and patch.diff`,
        { recordingDir: this.recordingDir, events: hasEvents, patch: hasPatch },
      );
    }

    const events = await this.readEvents(eventsPath);
    const patch = await readFile(patchPath, 'utf8');

    const workspace = req.workspace ?? this.workspace ?? null;
    if (workspace && patch.trim() !== '') {
      await mkdir(workspace, { recursive: true });
      this.applyPatch(patchPath, workspace);
    }

    const handle: SessionHandle = {
      adapterId: this.id,
      runId: req.runId,
      sessionRef: `replay-${req.runId}`,
      ...(req.model ? { model: req.model } : {}),
      meta: {
        replay: {
          recordingDir: this.recordingDir,
          events: events.length,
          patchBytes: Buffer.byteLength(patch),
          workspace: workspace ?? null,
        } as unknown as JsonValue,
      },
    };

    this.sessions.set(req.runId, {
      handle,
      events,
      patch,
      workspace,
      sequencer: createSequencer({ clock: this.clock }),
      cancelled: false,
    });

    return handle;
  }

  async sendPrompt(
    handle: SessionHandle,
    parts: PromptPart[],
    opts: PromptOptions = {},
  ): Promise<void> {
    this.requireSession(handle);
    void parts;
    // Structured output is not a recorded artefact; refuse rather than pretend.
    if (opts.structuredOutput) {
      throw new AdapterError('unsupported_capability', 'replay adapter has no structured output');
    }
  }

  async *streamEvents(
    handle: SessionHandle,
    signal?: AbortSignal,
  ): AsyncIterable<FactoryEvent> {
    const session = this.requireSession(handle);
    const sequencer = session.sequencer;
    const emit = (body: FactoryEventInput): FactoryEvent => {
      this.emitted += 1;
      return sequencer.stamp(body);
    };

    // A recording normally starts with `run.started`; synthesise one when it does not so the
    // canonical contract (start first, exactly one terminal) holds for consumers.
    if (session.events[0]?.type !== 'run.started') {
      yield emit(this.startedBody(handle, session));
    }

    for (const recorded of session.events) {
      if (session.cancelled || signal?.aborted) {
        yield emit({ type: 'run.completed', status: 'cancelled', summary: 'cancelled' });
        return;
      }

      if (recorded.type === 'run.started') {
        yield emit(this.startedBody(handle, session));
      } else {
        yield emit(bodyOf(recorded));
      }

      if (isTerminalEvent(recorded)) return;
    }

    // No terminal event in the recording: end the run so the pump never waits forever.
    yield emit({
      type: 'run.completed',
      status: 'ok',
      summary: 'replayed recording had no terminal event',
    });
  }

  async cancel(handle: SessionHandle, reason?: string): Promise<void> {
    const session = this.sessions.get(handle.runId);
    if (!session) return;
    session.cancelled = true;
    void reason;
  }

  async resume(_handle: SessionHandle, _sessionRef?: string): Promise<SessionHandle> {
    throw new AdapterError(
      'unsupported_capability',
      'replay adapter does not support resume; start a fresh replay',
      { capability: 'resume' },
    );
  }

  async respondToPermission(
    handle: SessionHandle,
    requestId: string,
    decision: PermissionDecision,
  ): Promise<void> {
    // The recorded stream already contains the consequences of the recorded decision; the
    // acknowledgement is a no-op so the pump can continue from the same iterator.
    this.requireSession(handle);
    void requestId;
    void decision;
  }

  async listAgents(_handle: SessionHandle): Promise<AgentDescriptor[]> {
    return [];
  }

  async getDiff(handle: SessionHandle): Promise<FileDiff[]> {
    const session = this.requireSession(handle);
    return [{ path: 'patch.diff', diff: session.patch, status: 'modified' }];
  }

  async getUsage(handle: SessionHandle): Promise<UsageReport> {
    const session = this.requireSession(handle);
    // Tokens are the recorded run's; cost is zero because a replay calls no model.
    const usage = [...session.events]
      .reverse()
      .find((event): event is UsageUpdatedEvent => event.type === 'usage.updated');
    const report: UsageReport = {
      inputTokens: usage ? usage.inputTokens : 0,
      outputTokens: usage ? usage.outputTokens : 0,
      costUsd: 0,
    };
    if (usage && usage.cacheReadTokens !== undefined) report.cacheReadTokens = usage.cacheReadTokens;
    if (usage && usage.reasoningTokens !== undefined) report.reasoningTokens = usage.reasoningTokens;
    return report;
  }

  async dispose(handle: SessionHandle): Promise<void> {
    this.sessions.delete(handle.runId);
  }

  getStats(): AdapterStats {
    return { droppedEvents: 0, emittedEvents: this.emitted };
  }

  /* ---------------------------------------------------------------------- */

  private startedBody(handle: SessionHandle, session: ReplaySession): FactoryEventInput {
    const recorded = session.events.find(
      (event): event is RunStartedEvent => event.type === 'run.started',
    );
    return {
      type: 'run.started',
      runId: handle.runId,
      harness: this.id,
      ...(recorded?.model ? { model: recorded.model } : {}),
    };
  }

  private async readEvents(path: string): Promise<FactoryEvent[]> {
    const raw = await readFile(path, 'utf8');
    const events: FactoryEvent[] = [];
    const lines = raw.split('\n');
    for (const [index, line] of lines.entries()) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        throw new AdapterError('invalid_response', `${path}:${index + 1} is not JSON`, {
          path,
          line: index + 1,
        });
      }
      const event = parseFactoryEvent(parsed);
      if (!event) {
        throw new AdapterError('invalid_response', `${path}:${index + 1} is not a canonical event`, {
          path,
          line: index + 1,
        });
      }
      events.push(event);
    }
    return events;
  }

  private requireSession(handle: SessionHandle): ReplaySession {
    const session = this.sessions.get(handle.runId);
    if (!session) {
      throw new AdapterError('session_not_found', `unknown replay session ${handle.runId}`, {
        runId: handle.runId,
      });
    }
    return session;
  }
}

/** Strips the producer envelope so the sequencer can stamp a fresh `seq`/`at`. */
function bodyOf(event: FactoryEvent): FactoryEventInput {
  const { seq: _seq, at: _at, ...body } = event;
  return body as FactoryEventInput;
}
