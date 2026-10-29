import {
  FakeAdapter,
  OpencodeAdapter,
  type AdapterCapabilities,
  type HarnessAdapter,
  type SessionHandle,
} from '@factory/adapters';
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

  let handle = await adapter.startSession({
    runId: input.runId,
    model: input.model,
    agent: input.agent,
    title: input.title ?? `run ${input.runId}`,
    workspace: input.workspace,
    metadata: { factory: input.factory, definitionCommit: input.definitionCommit },
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
  sessions.clear();
}
