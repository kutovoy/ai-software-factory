import {
  FakeAdapter,
  OpencodeAdapter,
  type AdapterCapabilities,
  type FactoryEvent,
  type HarnessAdapter,
  type McpSessionWiring,
  type SessionHandle,
} from '@factory/adapters';
import { loadDefinition, resolveMcpWiring } from '@factory/core';
import type { HarnessId, RunInput } from './types';

interface SessionEntry {
  adapter: HarnessAdapter;
  handle: SessionHandle;
  input: RunInput;
}

/**
 * In-worker session registry.
 *
 * Activities are separate invocations, so the adapter instance has to outlive a single
 * activity: the registry keeps one adapter + session per run for the lifetime of the
 * worker process. After a worker restart the registry is empty and `ensureSession`
 * recreates the session (resume when the adapter supports it, fresh session otherwise —
 * the spec allows that and the workflow records it).
 */
const sessions = new Map<string, SessionEntry>();

/**
 * Per-run adapter event stream.
 *
 * A pump activity now returns as soon as a permission is requested (ADR-013), so the
 * iterator must outlive one activity invocation: it is cached here and the next segment
 * continues from the same generator. That keeps in-flight events intact (no SSE
 * re-subscription gap, no scripted-adapter replay) and makes the persisted `seq` stream
 * strictly monotonic. After a worker restart the registry is empty and a fresh stream is
 * created — exactly the previous behaviour, deduplicated by `(runId, seq)`.
 */
interface StreamEntry {
  iterator: AsyncIterator<FactoryEvent>;
  controller: AbortController;
}

const streams = new Map<string, StreamEntry>();

export interface EnsureSessionOptions {
  harnessUrl?: string;
  sessionRef?: string | null;
  password?: string;
}

export function createAdapter(harness: HarnessId, options: EnsureSessionOptions & { fakeDelayMs?: number }): HarnessAdapter {
  switch (harness) {
    case 'fake':
      return new FakeAdapter({ delayMs: options.fakeDelayMs ?? 0 });
    case 'opencode':
      if (!options.harnessUrl) {
        throw new Error('opencode adapter requires a harnessUrl from the runner lease');
      }
      return new OpencodeAdapter({
        baseUrl: options.harnessUrl,
        password: options.password,
      });
    default:
      throw new Error(`harness "${harness}" has no adapter implementation yet`);
  }
}

export function getSession(runId: string): SessionEntry | undefined {
  return sessions.get(runId);
}

/**
 * Resolves the per-agent MCP wiring from the definition the run is pinned to (ADR-027).
 *
 * Best effort: a missing/unreadable definition degrades to "no MCP servers" rather than
 * failing the session — the definition was already validated when the run was created.
 * Names only; the adapter renders credentials as `{env:NAME}` templates.
 */
export function mcpWiringFor(input: RunInput): McpSessionWiring | undefined {
  try {
    const { definition } = loadDefinition(input.factoryRoot);
    if (!definition) return undefined;
    const wiring = resolveMcpWiring(definition, input.agent ?? null);
    return {
      servers: wiring.servers,
      permissions: wiring.permissions,
      ...(wiring.agent ? { agent: wiring.agent } : {}),
    };
  } catch {
    return undefined;
  }
}

/** Returns the cached event stream for a run, creating one from the session if absent. */
export function getOrCreateStream(entry: SessionEntry, runId: string): StreamEntry {
  const existing = streams.get(runId);
  if (existing) return existing;
  const controller = new AbortController();
  const created: StreamEntry = {
    iterator: entry.adapter.streamEvents(entry.handle, controller.signal)[Symbol.asyncIterator](),
    controller,
  };
  streams.set(runId, created);
  return created;
}

export function getStream(runId: string): StreamEntry | undefined {
  return streams.get(runId);
}

/** Aborts and forgets the cached stream (terminal state, cancellation, or adapter failure). */
export function dropStream(runId: string): void {
  const entry = streams.get(runId);
  if (!entry) return;
  streams.delete(runId);
  try {
    entry.controller.abort();
  } catch {
    // aborting an already-closed stream is a no-op
  }
}

export async function ensureSession(
  input: RunInput,
  options: EnsureSessionOptions = {},
): Promise<SessionEntry> {
  const existing = sessions.get(input.runId);
  if (existing) return existing;

  const adapter = createAdapter(input.harness, {
    ...options,
    fakeDelayMs: input.fakeDelayMs,
  });

  const mcp = mcpWiringFor(input);

  let handle = await adapter.startSession({
    runId: input.runId,
    model: input.model,
    agent: input.agent,
    title: input.title ?? `run ${input.runId}`,
    workspace: input.workspace,
    metadata: { factory: input.factory, definitionCommit: input.definitionCommit },
    ...(mcp ? { mcp } : {}),
  });

  const wantsResume =
    options.sessionRef !== undefined && options.sessionRef !== null && adapter.capabilities.resume;
  if (wantsResume) {
    handle = await adapter.resume(handle, options.sessionRef ?? undefined);
  }

  const entry: SessionEntry = { adapter, handle, input };
  sessions.set(input.runId, entry);
  return entry;
}

export async function dropSession(runId: string): Promise<void> {
  dropStream(runId);
  const entry = sessions.get(runId);
  sessions.delete(runId);
  if (entry) {
    try {
      await entry.adapter.dispose(entry.handle);
    } catch {
      // disposal is best-effort; the run is already terminal
    }
  }
}

export function capabilitiesOf(adapter: HarnessAdapter): AdapterCapabilities {
  return adapter.capabilities;
}

/** Test hook: clear the registry between cases. */
export function clearSessions(): void {
  for (const runId of streams.keys()) dropStream(runId);
  sessions.clear();
}
