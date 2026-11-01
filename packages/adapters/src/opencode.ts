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
  type EventSequencer,
  type FactoryEvent,
  type FactoryEventInput,
  type JsonValue,
} from './events';
import { buildOpencodeSessionConfig } from './mcp';
import { readSseStream, type SseFrame } from './sse';

/**
 * opencode adapter — native HTTP + SSE against `opencode serve` v2.
 *
 * Endpoints used (verified against the installed CLI, `opencode v2.0.26`, and its
 * OpenAPI document at `GET /openapi.json`):
 *   GET  /api/info                                  readiness probe
 *   POST /api/session                               create session
 *   GET  /api/session/:id                           session info / usage
 *   POST /api/session/:id/prompt                    admit prompt (async execution)
 *   GET  /api/event                                 SSE bus (global)
 *   POST /api/session/:id/interrupt                 cancel
 *   GET  /api/session/:id/permission                pending permission requests
 *   POST /api/session/:id/permission/:rid/reply     permission decision
 *   GET  /api/session/:id/diff                      file diffs
 *   POST /api/session/:id/fork                      fork at a message
 *   GET  /api/agent                                 agents
 *
 * The published docs (https://opencode.ai/docs/server/) still describe the v1 surface
 * (`POST /session`, `POST /session/:id/prompt_async`, `GET /event`, OpenAPI at `/doc`).
 * The installed v2 server moved the API under `/api`, replaced `prompt_async` with the
 * durable `prompt` endpoint, replaced `abort` with `interrupt`, and serves the OpenAPI
 * document at `/openapi.json` (`/doc` is the web UI). This adapter follows the installed
 * server, and the v1 names are still recognised by the mapper where payload shapes match.
 */

export interface ReadinessOptions {
  timeoutMs: number;
  initialDelayMs: number;
  maxDelayMs: number;
  factor: number;
}

export interface OpencodeTransport {
  request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T>;
  stream(path: string, signal?: AbortSignal): AsyncIterable<unknown>;
}

export interface HttpTransportOptions {
  baseUrl: string;
  /** `OPENCODE_SERVER_PASSWORD`. When set, HTTP basic auth is applied. */
  password?: string;
  /** Defaults to `opencode`, matching the server. */
  username?: string;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
}

function basicAuth(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
}

function describeHttpError(status: number, body: unknown): { message: string; tag?: string } {
  if (body && typeof body === 'object') {
    const record = body as Record<string, unknown>;
    const message = typeof record.message === 'string' ? record.message : JSON.stringify(body);
    const tag = typeof record._tag === 'string' ? record._tag : undefined;
    return { message, tag };
  }
  return { message: typeof body === 'string' ? body : `HTTP ${status}` };
}

export function createHttpTransport(options: HttpTransportOptions): OpencodeTransport {
  const baseUrl = options.baseUrl.replace(/\/$/, '');
  const fetchImpl = options.fetchImpl ?? fetch;
  const username = options.username ?? 'opencode';
  const timeoutMs = options.requestTimeoutMs ?? 30_000;

  const headers = (): Record<string, string> => {
    const result: Record<string, string> = { 'content-type': 'application/json' };
    if (options.password) result.authorization = basicAuth(username, options.password);
    return result;
  };

  const signalFor = (signal?: AbortSignal): AbortSignal =>
    signal ?? AbortSignal.timeout(timeoutMs);

  return {
    async request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal) {
      let response: Response;
      try {
        response = await fetchImpl(`${baseUrl}${path}`, {
          method,
          headers: headers(),
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: signalFor(signal),
        });
      } catch (error) {
        throw networkError(error, baseUrl);
      }

      if (response.status === 204) return undefined as T;

      const text = await response.text();
      let parsed: unknown = undefined;
      if (text.length > 0) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = text;
        }
      }

      if (!response.ok) {
        const { message, tag } = describeHttpError(response.status, parsed);
        const code = response.status === 404 ? 'session_not_found' : 'harness_error';
        throw new AdapterError(code, message, { status: response.status, tag, path });
      }

      return parsed as T;
    },

    async *stream(path: string, signal?: AbortSignal): AsyncIterable<unknown> {
      let response: Response;
      try {
        response = await fetchImpl(`${baseUrl}${path}`, {
          headers: { ...headers(), accept: 'text/event-stream' },
          signal,
        });
      } catch (error) {
        throw networkError(error, baseUrl);
      }

      if (!response.ok || !response.body) {
        throw new AdapterError('harness_error', `SSE stream ${path} failed`, {
          status: response.status,
        });
      }

      for await (const frame of readSseStream(response.body)) {
        const payload = decodeFrame(frame);
        if (payload !== undefined) yield payload;
      }
    },
  };
}

function networkError(error: unknown, baseUrl: string): AdapterError {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
    return new AdapterError('aborted', `request to ${baseUrl} aborted: ${message}`, { baseUrl });
  }
  return new AdapterError('harness_unreachable', `cannot reach opencode at ${baseUrl}: ${message}`, {
    baseUrl,
    cause: message,
  });
}

function decodeFrame(frame: SseFrame): unknown {
  if (frame.data.trim() === '') return undefined;
  try {
    const parsed: unknown = JSON.parse(frame.data);
    if (
      frame.event &&
      parsed &&
      typeof parsed === 'object' &&
      typeof (parsed as Record<string, unknown>).type !== 'string'
    ) {
      return { ...(parsed as Record<string, unknown>), type: frame.event };
    }
    return parsed;
  } catch {
    // Malformed JSON: hand the mapper a sentinel so it counts a dropped event
    // instead of failing the run.
    return { type: '__invalid_sse__', data: { raw: frame.data } };
  }
}

/* -------------------------------------------------------------------------- */
/* Event mapping                                                              */
/* -------------------------------------------------------------------------- */

export interface OpencodeMapperOptions {
  runId: string;
  sessionRef?: string;
  model?: string;
}

/** Events we recognise but intentionally do not translate (UI-only, pty, etc.). */
const KNOWN_NOOP_TYPES = new Set<string>([
  'server.connected',
  'server.heartbeat',
  'session.created',
  'session.updated',
  'session.deleted',
  'session.compacted',
  'session.status',
  'session.next.text.started',
  'session.next.reasoning.started',
  'session.next.reasoning.delta',
  'session.next.reasoning.ended',
  'session.next.tool.input.ended',
  'session.next.tool.progress',
  'session.next.step.started',
  'session.next.prompt.admitted',
  'session.next.prompted',
  'session.next.synthetic',
  'session.next.shell.started',
  'session.next.shell.ended',
  'session.next.compaction.started',
  'session.next.compaction.delta',
  'session.next.compaction.ended',
  'session.next.retried',
  'session.next.revert.staged',
  'session.next.revert.cleared',
  'session.next.revert.committed',
  'session.next.agent.switched',
  'session.next.model.switched',
  'session.next.moved',
  'session.next.context.updated',
  'message.updated',
  'message.removed',
  'message.part.updated',
  'message.part.removed',
  'permission.v2.replied',
  'permission.replied',
  'question.v2.asked',
  'question.v2.replied',
  'question.v2.rejected',
  'question.asked',
  'question.replied',
  'question.rejected',
  'todo.updated',
  'lsp.updated',
  'file.watcher.updated',
  'project.updated',
  'project.directories.updated',
  'plugin.added',
  'mcp.tools.changed',
  'mcp.browser.open.failed',
  'command.executed',
  'vcs.branch.updated',
  'reference.updated',
  'global.disposed',
  'models.dev.refreshed',
  'integration.updated',
  'integration.connection.updated',
  'catalog.updated',
]);

const KNOWN_NOOP_PREFIXES = [
  'pty.',
  'tui.',
  'workspace.',
  'worktree.',
  'installation.',
];

export interface OpencodeMapperStats {
  dropped: number;
  mapped: number;
}

/**
 * Translates opencode bus events into canonical factory events.
 *
 * Unknown payloads are dropped and counted — never fatal. Events belonging to another
 * session are ignored without being counted as dropped.
 */
export class OpencodeEventMapper {
  private readonly startedCalls = new Set<string>();
  private readonly sessionRef: string | undefined;
  private cancelled = false;
  private failure: string | undefined;
  private done = false;
  private droppedCount = 0;
  private mappedCount = 0;

  constructor(options: OpencodeMapperOptions) {
    this.sessionRef = options.sessionRef;
  }

  get stats(): OpencodeMapperStats {
    return { dropped: this.droppedCount, mapped: this.mappedCount };
  }

  get pendingError(): string | undefined {
    return this.failure;
  }

  get finished(): boolean {
    return this.done;
  }

  markCancelled(): void {
    this.cancelled = true;
  }

  map(raw: unknown): FactoryEventInput[] {
    if (!raw || typeof raw !== 'object') {
      this.droppedCount += 1;
      return [];
    }

    const event = raw as Record<string, unknown>;
    const type = typeof event.type === 'string' ? event.type : undefined;
    if (!type) {
      this.droppedCount += 1;
      return [];
    }

    const data =
      event.data && typeof event.data === 'object'
        ? (event.data as Record<string, unknown>)
        : ({} as Record<string, unknown>);

    const sessionID = typeof data.sessionID === 'string' ? data.sessionID : undefined;
    if (this.sessionRef && sessionID && sessionID !== this.sessionRef) return [];

    const bodies = this.translate(type, data);
    if (bodies === undefined) {
      this.droppedCount += 1;
      return [];
    }

    this.mappedCount += bodies.length;
    return bodies;
  }

  private translate(type: string, data: Record<string, unknown>): FactoryEventInput[] | undefined {
    switch (type) {
      case 'session.next.text.delta':
        return [{ type: 'message.delta', role: 'assistant', text: asString(data.delta) }];

      case 'session.next.text.ended':
        return [{ type: 'message.completed', role: 'assistant', text: asString(data.text) }];

      // v1 compatibility: `message.part.delta` carries the same streaming text delta.
      case 'message.part.delta':
        return [{ type: 'message.delta', role: 'assistant', text: asString(data.delta) }];

      case 'session.next.tool.input.started': {
        const callId = asString(data.callID);
        if (!callId) return undefined;
        this.startedCalls.add(callId);
        return [
          {
            type: 'tool.call.started',
            callId,
            name: asString(data.name) || 'unknown',
            args: {},
          },
        ];
      }

      case 'session.next.tool.input.delta': {
        const callId = asString(data.callID);
        if (!callId) return undefined;
        return [{ type: 'tool.call.args.delta', callId, delta: asString(data.delta) }];
      }

      case 'session.next.tool.called': {
        const callId = asString(data.callID);
        if (!callId) return undefined;
        // Already announced while the arguments streamed in.
        if (this.startedCalls.has(callId)) return [];
        this.startedCalls.add(callId);
        return [
          {
            type: 'tool.call.started',
            callId,
            name: asString(data.tool) || 'unknown',
            args: asJsonObject(data.input),
          },
        ];
      }

      case 'session.next.tool.success': {
        const callId = asString(data.callID);
        if (!callId) return undefined;
        return [
          {
            type: 'tool.call.completed',
            callId,
            ok: true,
            result: {
              structured: asJsonObject(data.structured),
              content: asJsonArray(data.content),
            },
          },
        ];
      }

      case 'session.next.tool.failed': {
        const callId = asString(data.callID);
        if (!callId) return undefined;
        return [
          {
            type: 'tool.call.completed',
            callId,
            ok: false,
            result: { error: asJsonValue(data.error) },
          },
        ];
      }

      case 'permission.v2.asked':
      case 'permission.asked': {
        const requestId = asString(data.id);
        if (!requestId) return undefined;
        const detail: Record<string, JsonValue> = {
          resources: asJsonArray(data.resources),
        };
        if (data.save !== undefined) detail.save = asJsonArray(data.save);
        if (data.metadata !== undefined) detail.metadata = asJsonObject(data.metadata);
        return [
          {
            type: 'permission.requested',
            requestId,
            action: asString(data.action) || 'unknown',
            detail,
          },
        ];
      }

      case 'file.edited': {
        const path = asString(data.file);
        if (!path) return undefined;
        return [{ type: 'file.edited', path, diff: '' }];
      }

      case 'session.diff': {
        const diff = asJsonArray(data.diff);
        const bodies: FactoryEventInput[] = [];
        for (const entry of diff) {
          if (!entry || typeof entry !== 'object') continue;
          const file = entry as Record<string, unknown>;
          const path = asString(file.file);
          if (!path) continue;
          bodies.push({ type: 'file.edited', path, diff: asString(file.patch) });
        }
        return bodies;
      }

      case 'session.next.step.ended': {
        const tokens = asJsonObject(data.tokens);
        const cache = asJsonObject(tokens.cache);
        this.failure = undefined;
        return [
          {
            type: 'usage.updated',
            inputTokens: asNumber(tokens.input),
            outputTokens: asNumber(tokens.output),
            ...(typeof data.cost === 'number' ? { costUsd: data.cost } : {}),
            ...(typeof cache.read === 'number' ? { cacheReadTokens: cache.read } : {}),
            ...(typeof tokens.reasoning === 'number'
              ? { reasoningTokens: tokens.reasoning }
              : {}),
          },
        ];
      }

      case 'session.next.step.failed': {
        this.failure = summariseError(data.error);
        return [];
      }

      case 'session.error': {
        this.done = true;
        return [
          {
            type: 'run.completed',
            status: 'error',
            summary: summariseError(data.error),
          },
        ];
      }

      case 'session.idle': {
        this.done = true;
        if (this.cancelled) {
          return [{ type: 'run.completed', status: 'cancelled', summary: 'cancelled' }];
        }
        if (this.failure) {
          return [{ type: 'run.completed', status: 'error', summary: this.failure }];
        }
        return [{ type: 'run.completed', status: 'ok' }];
      }

      default:
        if (KNOWN_NOOP_TYPES.has(type)) return [];
        if (KNOWN_NOOP_PREFIXES.some((prefix) => type.startsWith(prefix))) return [];
        return undefined;
    }
  }
}

export function createOpencodeMapper(options: OpencodeMapperOptions): OpencodeEventMapper {
  return new OpencodeEventMapper(options);
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function asJsonValue(value: unknown): JsonValue {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  try {
    return JSON.parse(JSON.stringify(value)) as JsonValue;
  } catch {
    return String(value);
  }
}

function asJsonObject(value: unknown): { [key: string]: JsonValue } {
  const converted = asJsonValue(value);
  return converted && typeof converted === 'object' && !Array.isArray(converted)
    ? (converted as { [key: string]: JsonValue })
    : {};
}

function asJsonArray(value: unknown): JsonValue[] {
  const converted = asJsonValue(value);
  return Array.isArray(converted) ? converted : [];
}

function summariseError(value: unknown): string {
  if (!value || typeof value !== 'object') return 'harness error';
  const record = value as Record<string, unknown>;
  if (typeof record.message === 'string') return record.message;
  if (typeof record._tag === 'string') return record._tag;
  try {
    return JSON.stringify(value);
  } catch {
    return 'harness error';
  }
}

/* -------------------------------------------------------------------------- */
/* Adapter                                                                    */
/* -------------------------------------------------------------------------- */

export interface OpencodeAdapterOptions {
  baseUrl: string;
  password?: string;
  username?: string;
  transport?: OpencodeTransport;
  fetchImpl?: typeof fetch;
  readiness?: Partial<ReadinessOptions>;
  requestTimeoutMs?: number;
  harnessName?: string;
  clock?: () => number;
}

const DEFAULT_READINESS: ReadinessOptions = {
  timeoutMs: 15_000,
  initialDelayMs: 150,
  maxDelayMs: 2_000,
  factor: 2,
};

interface SessionState {
  handle: SessionHandle;
  sequencer: EventSequencer;
  mapper: OpencodeEventMapper;
  cancelled: boolean;
}

interface SessionInfo {
  id?: string;
  cost?: number;
  tokens?: {
    input?: number;
    output?: number;
    reasoning?: number;
    cache?: { read?: number; write?: number };
  };
  model?: { id?: string; providerID?: string };
}

export class OpencodeAdapter implements HarnessAdapter {
  readonly id = 'opencode' as const;

  readonly capabilities: AdapterCapabilities = {
    streaming: true,
    toolCalls: true,
    permissions: 'interactive',
    resume: true,
    fork: true,
    usage: true,
    // The v2 `prompt` body has no JSON-schema `format` field, so structured output is
    // not exposed yet (v1 SDK advertised it; the installed server does not).
    structuredOutput: false,
    // MCP servers are part of the session config (spec `mcp-integration`).
    mcp: true,
  };

  private readonly transport: OpencodeTransport;
  private readonly readiness: ReadinessOptions;
  private readonly harnessName: string;
  private readonly clock: () => number;
  private readonly baseUrl: string;
  private readonly sessions = new Map<string, SessionState>();
  private emitted = 0;

  constructor(options: OpencodeAdapterOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.transport =
      options.transport ??
      createHttpTransport({
        baseUrl: this.baseUrl,
        password: options.password,
        username: options.username,
        fetchImpl: options.fetchImpl,
        requestTimeoutMs: options.requestTimeoutMs,
      });
    this.readiness = { ...DEFAULT_READINESS, ...options.readiness };
    this.harnessName = options.harnessName ?? 'opencode';
    this.clock = options.clock ?? Date.now;
  }

  get url(): string {
    return this.baseUrl;
  }

  /** Readiness probe with exponential backoff. Throws `harness_unreachable` on timeout. */
  async probe(signal?: AbortSignal): Promise<unknown> {
    const deadline = Date.now() + this.readiness.timeoutMs;
    let delay = this.readiness.initialDelayMs;
    let lastError = 'no response';

    while (Date.now() < deadline) {
      if (signal?.aborted) throw new AdapterError('aborted', 'readiness probe aborted');
      try {
        return await this.transport.request('GET', '/api/info', undefined, signal);
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        await sleep(delay, signal);
        delay = Math.min(delay * this.readiness.factor, this.readiness.maxDelayMs);
      }
    }

    throw new AdapterError(
      'harness_unreachable',
      `opencode at ${this.baseUrl} did not answer /api/info within ${this.readiness.timeoutMs}ms`,
      { baseUrl: this.baseUrl, timeoutMs: this.readiness.timeoutMs, lastError },
    );
  }

  async startSession(req: StartSessionRequest): Promise<SessionHandle> {
    await this.probe();

    const body: Record<string, unknown> = {
      title: req.title ?? `factory run ${req.runId}`,
    };
    if (req.agent) body.agent = req.agent;
    const modelRef = parseModelRef(req.model);
    if (modelRef) body.model = modelRef;

    // MCP wiring + per-agent permission globs travel with the session (ADR-027). The
    // config holds `{env:NAME}` templates only — never a credential value (ADR-026).
    const sessionConfig = req.mcp ? buildOpencodeSessionConfig(req.mcp) : undefined;
    if (sessionConfig) body.config = sessionConfig;

    const response = await this.transport.request<{ data?: SessionInfo }>(
      'POST',
      '/api/session',
      body,
    );
    const info = response?.data;
    const sessionRef = info?.id;
    if (!sessionRef) {
      throw new AdapterError('invalid_response', 'POST /api/session returned no session id', {
        response,
      });
    }

    const handle: SessionHandle = {
      adapterId: this.id,
      runId: req.runId,
      sessionRef,
      harnessUrl: this.baseUrl,
      model: req.model ?? formatModelRef(info?.model),
      ...(sessionConfig
        ? {
            meta: {
              mcp: {
                supported: true,
                agent: req.mcp?.agent ?? null,
                servers: req.mcp?.servers.map((server) => server.name) ?? [],
                permissions: { ...(req.mcp?.permissions ?? {}) },
              },
            },
          }
        : {}),
    };

    this.sessions.set(req.runId, {
      handle,
      sequencer: createSequencer({ clock: this.clock }),
      mapper: createOpencodeMapper({
        runId: req.runId,
        sessionRef,
        model: handle.model,
      }),
      cancelled: false,
    });

    return handle;
  }

  async sendPrompt(
    handle: SessionHandle,
    parts: PromptPart[],
    opts: PromptOptions = {},
  ): Promise<void> {
    const state = this.requireState(handle);
    if (opts.structuredOutput && !this.capabilities.structuredOutput) {
      throw new AdapterError(
        'unsupported_capability',
        'opencode v2 does not expose structured output on /api/session/:id/prompt',
        { capability: 'structuredOutput' },
      );
    }

    const text = parts
      .filter((part): part is Extract<PromptPart, { type: 'text' }> => part.type === 'text')
      .map((part) => part.text)
      .join('\n');

    const files = parts
      .filter(
        (part): part is Extract<PromptPart, { type: 'file' | 'image' }> =>
          part.type === 'file' || part.type === 'image',
      )
      .map((part) => ({ uri: part.path, name: part.name, mention: undefined }));

    const body: Record<string, unknown> = { text, resume: true };
    if (files.length > 0) body.files = files;
    if (opts.agent) body.agent = opts.agent;
    if (opts.model) {
      const modelRef = parseModelRef(opts.model);
      if (modelRef) body.model = modelRef;
    }

    await this.transport.request(
      'POST',
      `/api/session/${encodeURIComponent(state.handle.sessionRef!)}/prompt`,
      body,
    );
  }

  async *streamEvents(handle: SessionHandle, signal?: AbortSignal): AsyncIterable<FactoryEvent> {
    const state = this.requireState(handle);
    let terminal = false;

    const emit = (body: FactoryEventInput): FactoryEvent => {
      this.emitted += 1;
      return state.sequencer.stamp(body);
    };

    yield emit({
      type: 'run.started',
      runId: handle.runId,
      harness: this.harnessName,
      model: handle.model,
    });

    try {
      for await (const raw of this.transport.stream('/api/event', signal)) {
        if (state.cancelled) state.mapper.markCancelled();
        const bodies = state.mapper.map(raw);
        for (const body of bodies) {
          const event = emit(body);
          if (event.type === 'run.completed') terminal = true;
          yield event;
        }
        if (state.mapper.finished || terminal) return;
      }
    } catch (error) {
      if (terminal) return;
      if (state.cancelled || signal?.aborted) {
        yield emit({ type: 'run.completed', status: 'cancelled', summary: 'cancelled' });
        return;
      }
      yield emit({
        type: 'run.completed',
        status: 'error',
        summary: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    if (terminal) return;
    if (state.cancelled) {
      yield emit({ type: 'run.completed', status: 'cancelled', summary: 'cancelled' });
      return;
    }
    yield emit({
      type: 'run.completed',
      status: 'error',
      summary: 'harness event stream closed before the run completed',
    });
  }

  async cancel(handle: SessionHandle, reason?: string): Promise<void> {
    const state = this.requireState(handle);
    state.cancelled = true;
    state.mapper.markCancelled();
    void reason;
    try {
      await this.transport.request(
        'POST',
        `/api/session/${encodeURIComponent(state.handle.sessionRef!)}/interrupt`,
      );
    } catch {
      // Best effort: the stream ending (or the runner being killed) is the real stop.
    }
  }

  async resume(handle: SessionHandle, sessionRef?: string): Promise<SessionHandle> {
    const ref = sessionRef ?? handle.sessionRef;
    if (!ref) return this.startSession({ runId: handle.runId, model: handle.model });

    const response = await this.transport.request<{ data?: SessionInfo }>(
      'GET',
      `/api/session/${encodeURIComponent(ref)}`,
    );
    if (!response?.data?.id) {
      throw new AdapterError('session_not_found', `session ${ref} not found`, { sessionRef: ref });
    }

    const resumed: SessionHandle = {
      ...handle,
      sessionRef: response.data.id,
      model: handle.model ?? formatModelRef(response.data.model),
    };

    this.sessions.set(handle.runId, {
      handle: resumed,
      sequencer: createSequencer({ clock: this.clock }),
      mapper: createOpencodeMapper({
        runId: handle.runId,
        sessionRef: resumed.sessionRef,
        model: resumed.model,
      }),
      cancelled: false,
    });

    return resumed;
  }

  async fork(handle: SessionHandle, atMessageId?: string): Promise<SessionHandle> {
    const state = this.requireState(handle);
    const body = atMessageId ? { messageID: atMessageId } : {};
    const response = await this.transport.request<{ data?: SessionInfo }>(
      'POST',
      `/api/session/${encodeURIComponent(state.handle.sessionRef!)}/fork`,
      body,
    );
    const forked = response?.data?.id;
    if (!forked) {
      throw new AdapterError('invalid_response', 'fork returned no session id', { response });
    }
    return {
      ...handle,
      sessionRef: forked,
      meta: { ...(handle.meta ?? {}), forkedFrom: state.handle.sessionRef ?? '' },
    };
  }

  async respondToPermission(
    handle: SessionHandle,
    requestId: string,
    decision: PermissionDecision,
  ): Promise<void> {
    const state = this.requireState(handle);
    const reply = decision === 'allow' ? 'once' : decision === 'always' ? 'always' : 'reject';
    await this.transport.request(
      'POST',
      `/api/session/${encodeURIComponent(state.handle.sessionRef!)}/permission/${encodeURIComponent(requestId)}/reply`,
      { decision: reply },
    );
  }

  async listAgents(handle: SessionHandle): Promise<AgentDescriptor[]> {
    this.requireState(handle);
    const response = await this.transport.request<{
      data?: Array<{
        id?: string;
        name?: string;
        mode?: string;
        description?: string;
        hidden?: boolean;
        model?: { id?: string; providerID?: string };
      }>;
    }>('GET', '/api/agent');
    return (response?.data ?? []).map((agent) => ({
      id: agent.id ?? '',
      name: agent.name ?? agent.id ?? '',
      mode: agent.mode as AgentDescriptor['mode'],
      description: agent.description,
      hidden: agent.hidden,
      model: formatModelRef(agent.model),
    }));
  }

  async getDiff(handle: SessionHandle): Promise<FileDiff[]> {
    const state = this.requireState(handle);
    const response = await this.transport.request<{
      data?: Array<{
        file?: string;
        patch?: string;
        additions?: number;
        deletions?: number;
        status?: string;
      }>;
    }>('GET', `/api/session/${encodeURIComponent(state.handle.sessionRef!)}/diff`);
    return (response?.data ?? [])
      .filter((entry) => typeof entry.file === 'string')
      .map((entry) => ({
        path: entry.file!,
        diff: entry.patch ?? '',
        status: entry.status as FileDiff['status'],
        additions: entry.additions,
        deletions: entry.deletions,
      }));
  }

  async getUsage(handle: SessionHandle): Promise<UsageReport> {
    const state = this.requireState(handle);
    const response = await this.transport.request<{ data?: SessionInfo }>(
      'GET',
      `/api/session/${encodeURIComponent(state.handle.sessionRef!)}`,
    );
    const info = response?.data ?? {};
    return {
      inputTokens: info.tokens?.input ?? 0,
      outputTokens: info.tokens?.output ?? 0,
      reasoningTokens: info.tokens?.reasoning ?? 0,
      cacheReadTokens: info.tokens?.cache?.read ?? 0,
      costUsd: info.cost ?? 0,
    };
  }

  async dispose(handle: SessionHandle): Promise<void> {
    const state = this.sessions.get(handle.runId);
    if (!state) return;
    if (state.handle.sessionRef) {
      try {
        await this.transport.request(
          'POST',
          `/api/session/${encodeURIComponent(state.handle.sessionRef)}/interrupt`,
          { resume: false },
        );
      } catch {
        // ignore: disposing must never throw
      }
    }
    this.sessions.delete(handle.runId);
  }

  getStats(): AdapterStats {
    let dropped = 0;
    for (const state of this.sessions.values()) {
      dropped += state.mapper.stats.dropped;
    }
    return { droppedEvents: dropped, emittedEvents: this.emitted };
  }

  private requireState(handle: SessionHandle): SessionState {
    const state = this.sessions.get(handle.runId);
    if (!state) {
      throw new AdapterError('session_not_found', `unknown run ${handle.runId}`, {
        runId: handle.runId,
      });
    }
    return state;
  }
}

export function createOpencodeAdapter(options: OpencodeAdapterOptions): OpencodeAdapter {
  return new OpencodeAdapter(options);
}

/** Provider id declared by the runner image's opencode config (`packages/runners/docker`). */
const FACTORY_PROVIDER_ID = 'factory';

function parseModelRef(model?: string): { providerID: string; id: string } | undefined {
  if (!model) return undefined;
  const slash = model.indexOf('/');
  if (slash <= 0 || slash === model.length - 1) {
    // A bare name (`best_llm`) is a model served by the factory proxy, not "whatever
    // opencode defaults to". Without this, the model is never sent and opencode silently
    // falls back to its built-in default (gpt-6.1-terra against api.openai.com), so the run
    // answers with the wrong model from the wrong endpoint.
    return { providerID: FACTORY_PROVIDER_ID, id: model };
  }
  return { providerID: model.slice(0, slash), id: model.slice(slash + 1) };
}

function formatModelRef(model?: { id?: string; providerID?: string }): string | undefined {
  if (!model?.id) return undefined;
  return model.providerID ? `${model.providerID}/${model.id}` : model.id;
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
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
