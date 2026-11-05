
import type { FactoryEvent, PromptPart } from '@factory/adapters';
import { AdapterError } from '@factory/adapters';
import type { RemotePumpResult, RemoteRunStartPayload, RemoteRunStartResult } from '@factory/runners';
import { loadConfig } from '../config';
import { harnessPasswordFor } from '../harness-auth';
import { heartbeat } from '../heartbeat';
import { isCancelRequested, listSteps, setRunSessionRef, upsertStep } from '../db';
import { pumpSegment } from '../pump';
import { RemoteRunnerBackend, isRemoteRun } from '../remote-runner';
import { appendEvent, recordPermissionRequest } from './persist';
import { harnessCommandWithProxyEnv } from './runner';
import {
  agentDefinitionsFor,
  capabilitiesOf,
  dropStream,
  ensureSession,
  getOrCreateStream,
  getSession,
  getStream,
  mcpWiringFor,
} from '../sessions';
import type {
  HarnessStartInfo,
  LeaseInfo,
  PermissionDecisionValue,
  PumpResult,
  RunInput,
  TerminalStatus,
} from '../types';

/**
 * Harness activities. The harness itself runs inside the runner (ADR-009); these
 * activities only drive the adapter that talks to it.
 *
 * `pumpEvents` is the single writer for the run's event log: it streams canonical
 * events from the adapter, appends each one, and returns as soon as the harness asks for
 * a human decision (ADR-013). The decision itself is a workflow-level durable wait, so a
 * permission-blocked run costs zero activity slots; the workflow calls `pumpEvents` again
 * with `fromSeq` to resume the same in-process stream after the decision is forwarded.
 * On a worker restart the adapter session and stream are recreated and already-persisted
 * events are deduplicated by `seq`.
 */

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}


export async function startHarness(args: {
  input: RunInput;
  lease: LeaseInfo;
  sessionRef?: string | null;
  /** Proxy base URL + per-run token, baked into the harness command (never a provider key). */
  harnessEnv?: Record<string, string>;
}): Promise<HarnessStartInfo> {
  if (isRemoteRun(args.input)) return startRemoteHarness(args);

  const existed = getSession(args.input.runId) !== undefined;
  const entry = await ensureSession(args.input, {
    harnessUrl: args.lease.harnessUrl,
    sessionRef: args.sessionRef ?? null,
    // Derived per run (see `harness-auth.ts`): opencode generates a random server password
    // unless one is supplied, so the runner injects this same value into the harness env.
    password: harnessPasswordFor(args.input.runId),
  });

  if (entry.handle.sessionRef) {
    await setRunSessionRef(args.input.runId, entry.handle.sessionRef);
  }

  await upsertStep({
    runId: args.input.runId,
    stepId: 'start-harness',
    kind: 'harness',
    status: 'ok',
    detail: {
      // The adapter that actually ran: `replay` for a recorded run, never the requested
      // harness (a replay calls no model).
      harness: entry.adapter.id,
      model: args.input.model ?? null,
      harnessUrl: args.lease.harnessUrl ?? null,
      sessionRef: entry.handle.sessionRef ?? null,
      resumed: !existed && Boolean(args.sessionRef),
      ...(args.input.replayFrom ? { replayFrom: args.input.replayFrom } : {}),
      // MCP wiring actually handed to the harness (names + globs, never values).
      mcp: entry.handle.meta?.mcp ?? { supported: false, servers: [], permissions: {} },
    },
  });

  return {
    sessionRef: entry.handle.sessionRef,
    harnessUrl: args.lease.harnessUrl,
    capabilities: capabilitiesOf(entry.adapter),
    ...(entry.handle.meta?.mcp
      ? { mcp: entry.handle.meta.mcp as unknown as HarnessStartInfo['mcp'] }
      : {}),
    resumed: !existed && Boolean(args.sessionRef),
  };
}

/**
 * Remote start: the agent owns the harness adapter and sandbox. The central worker only
 * records the returned session metadata; it never talks to the harness directly.
 */
async function startRemoteHarness(args: {
  input: RunInput;
  lease: LeaseInfo;
  sessionRef?: string | null;
  harnessEnv?: Record<string, string>;
}): Promise<HarnessStartInfo> {
  const config = loadConfig();
  const remote = new RemoteRunnerBackend(config);
  const agents = agentDefinitionsFor(args.input);
  const activeAgent = args.input.agent
    ? agents?.find((agent) => agent.name === args.input.agent)
    : undefined;
  const promptParts = promptPartsFor(args.input.prompt, activeAgent);
  const mcp = mcpWiringFor(args.input);
  const harnessCommand = harnessCommandWithProxyEnv(args.harnessEnv, args.input.runId);
  // The agent needs the same derived password for its adapter; the command also carries it
  // for the harness process, but the adapter authenticates its HTTP calls separately.
  const remoteHarnessEnv = {
    ...(args.harnessEnv ?? {}),
    OPENCODE_SERVER_PASSWORD: harnessPasswordFor(args.input.runId),
  };

  const payload: RemoteRunStartPayload = {
    runId: args.input.runId,
    runnerId: args.lease.runnerId,
    harness: args.input.harness,
    ...(args.input.model ? { model: args.input.model } : {}),
    leaseSpec: {
      runId: args.input.runId,
      runnerId: args.lease.runnerId,
      ...(args.input.repo?.url ? { repo: { url: args.input.repo.url, commit: args.input.repo.commit } } : {}),
      harness: { command: harnessCommand, port: 4096, readyPath: '/api/info' },
      networkPolicy: args.input.networkPolicy ?? 'denied',
      keepWorkspace: false,
    },
    harnessCommand,
    harnessEnv: remoteHarnessEnv,
    harnessPort: 4096,
    readyPath: '/api/info',
    readyTimeoutMs: 60_000,
    promptParts,
    ...(agents ? { agents } : {}),
    ...(mcp ? { mcp } : {}),
    sessionRef: args.sessionRef ?? null,
    ...(args.input.fakeDelayMs !== undefined ? { fakeDelayMs: args.input.fakeDelayMs } : {}),
    metadata: { factory: args.input.factory, definitionCommit: args.input.definitionCommit },
  };

  const result = (await remote.sendForRunner(
    args.lease.runnerId,
    'start-session',
    payload,
    15 * 60 * 1000,
  )) as RemoteRunStartResult;

  if (result.sessionRef) await setRunSessionRef(args.input.runId, result.sessionRef);

  await upsertStep({
    runId: args.input.runId,
    stepId: 'start-harness',
    kind: 'harness',
    status: 'ok',
    detail: {
      harness: args.input.harness,
      model: args.input.model ?? null,
      harnessUrl: result.harnessUrl ?? null,
      sessionRef: result.sessionRef ?? null,
      resumed: Boolean(args.sessionRef),
      remote: true,
      mcp: result.mcp ?? { supported: false, servers: [], permissions: {} },
    },
  });

  return {
    ...(result.sessionRef ? { sessionRef: result.sessionRef } : {}),
    ...(result.harnessUrl ? { harnessUrl: result.harnessUrl } : {}),
    capabilities: (result.capabilities as HarnessStartInfo['capabilities']) ?? {
      streaming: true,
      toolCalls: true,
      permissions: 'interactive',
      resume: false,
      fork: false,
      usage: true,
      structuredOutput: false,
      mcp: false,
    },
    ...(result.mcp ? { mcp: result.mcp as HarnessStartInfo['mcp'] } : {}),
    resumed: Boolean(args.sessionRef),
  };
}

/**
 * Streams one segment of the adapter and returns as soon as the harness asks for a
 * permission decision (ADR-013).
 *
 * The segment loop lives in `pump.ts` (dependency-injected, unit-testable). This wrapper
 * supplies persistence, cancellation, heartbeats, and the per-run adapter stream, which is
 * cached in the session registry so a resumed segment continues the same iterator instead
 * of re-subscribing (no lost events, no scripted-adapter replay).
 *
 * `fromSeq` tells the pump which events are already persisted; `decided` carries the
 * decisions the workflow already holds, so a replayed `permission.requested` after a
 * worker restart is forwarded rather than surfaced again.
 */
/**
 * Remote pump: the agent streams canonical events from its local adapter; this activity
 * remains the single writer of the central event log. It loops over idle windows so the
 * workflow sees the same `permission`/`terminal`/`cancelled`/`closed` contract.
 */
async function pumpRemoteEvents(args: {
  input: RunInput;
  lease: LeaseInfo;
  fromSeq?: number;
  decided?: Record<string, PermissionDecisionValue>;
}): Promise<PumpResult> {
  const config = loadConfig();
  const remote = new RemoteRunnerBackend(config);
  const runId = args.input.runId;
  let lastSeq = args.fromSeq ?? 0;
  let appended = 0;
  let costUsd = 0;
  let droppedEvents = 0;

  await upsertStep({ runId, stepId: 'stream', kind: 'harness', status: 'running' });

  for (;;) {
    if (await isCancelRequested(runId)) {
      await remote
        .sendForRunner(args.lease.runnerId, 'cancel', { runId, reason: 'cancelled' }, 60_000)
        .catch(() => undefined);
      return {
        stopReason: 'cancelled',
        terminalStatus: 'cancelled',
        lastSeq,
        appended,
        droppedEvents,
        costUsd,
      };
    }

    const result = (await remote.sendForRunner(
      args.lease.runnerId,
      'pump',
      {
        runId,
        fromSeq: lastSeq,
        ...(args.decided ? { decided: args.decided } : {}),
        waitMs: 20_000,
      },
      60_000,
    )) as RemotePumpResult;

    for (const event of result.events ?? []) {
      const written = await appendEvent({ runId, stepId: 'stream', event });
      if (written.appended) {
        appended += 1;
        lastSeq = Math.max(lastSeq, written.seq ?? (event as { seq?: number }).seq ?? 0);
      } else {
        lastSeq = Math.max(lastSeq, (event as { seq?: number }).seq ?? 0);
      }
    }
    costUsd += result.costUsd ?? 0;
    droppedEvents += result.droppedEvents ?? 0;
    heartbeat({ waitingForEvent: result.stopReason === 'idle', lastSeq });

    if (result.stopReason === 'permission' && result.permissionRequestId) {
      await recordPermissionRequest({
        runId,
        requestId: result.permissionRequestId,
        action: result.permissionAction ?? 'permission',
        detail: {},
      });
      return {
        stopReason: 'permission',
        terminalStatus: result.terminalStatus ?? null,
        ...(result.terminalSummary ? { terminalSummary: result.terminalSummary } : {}),
        lastSeq,
        appended,
        droppedEvents,
        costUsd,
        permissionRequestId: result.permissionRequestId,
        ...(result.permissionAction ? { permissionAction: result.permissionAction } : {}),
      };
    }

    if (result.stopReason === 'terminal') {
      return {
        stopReason: 'terminal',
        terminalStatus: result.terminalStatus ?? 'ok',
        ...(result.terminalSummary ? { terminalSummary: result.terminalSummary } : {}),
        lastSeq,
        appended,
        droppedEvents,
        costUsd,
      };
    }

    if (result.stopReason === 'cancelled') {
      return {
        stopReason: 'cancelled',
        terminalStatus: 'cancelled',
        lastSeq,
        appended,
        droppedEvents,
        costUsd,
      };
    }

    if (result.stopReason === 'closed') {
      return {
        stopReason: 'closed',
        terminalStatus: result.terminalStatus ?? null,
        ...(result.terminalSummary ? { terminalSummary: result.terminalSummary } : {}),
        lastSeq,
        appended,
        droppedEvents,
        costUsd,
      };
    }

    // `idle`: no event yet. Keep the activity alive and heartbeat; the harness may be
    // thinking or waiting on a long tool call.
  }
}

export async function pumpEvents(args: {
  input: RunInput;
  lease: LeaseInfo;
  sessionRef?: string | null;
  fromSeq?: number;
  decided?: Record<string, PermissionDecisionValue>;
}): Promise<PumpResult> {
  if (isRemoteRun(args.input)) return pumpRemoteEvents(args);

  const entry = await ensureSession(args.input, {
    harnessUrl: args.lease.harnessUrl,
    sessionRef: args.sessionRef ?? null,
    // Derived per run (see `harness-auth.ts`): opencode generates a random server password
    // unless one is supplied, so the runner injects this same value into the harness env.
    password: harnessPasswordFor(args.input.runId),
  });

  const { adapter, handle } = entry;
  const runId = args.input.runId;

  await upsertStep({
    runId,
    stepId: 'stream',
    kind: 'harness',
    status: 'running',
  });

  const hadStream = getStream(runId) !== undefined;
  const stream = getOrCreateStream(entry, runId);

  // The harness may resolve or drop a permission itself when the stream is aborted, so a
  // late reply can legitimately be a no-op. Anything else is a real failure.
  const respond = async (
    requestId: string,
    decision: PermissionDecisionValue,
  ): Promise<void> => {
    try {
      await adapter.respondToPermission(handle, requestId, decision);
    } catch (error) {
      if (error instanceof AdapterError && error.code === 'permission_not_found') return;
      throw error;
    }
  };

  if (!hadStream && args.decided) {
    // A fresh stream means the adapter session was recreated (worker restart / retry).
    // Replay durable decisions best-effort so the harness is not left waiting on an answer
    // the workflow already has; a duplicate reply is a tolerated no-op.
    for (const [requestId, decision] of Object.entries(args.decided)) {
      try {
        await respond(requestId, decision);
      } catch {
        // best-effort: the harness may no longer know this request
      }
    }
  }

  // Start consuming before prompting: `streamEvents()` is an async generator, so the SSE
  // connection only opens on the first `next()`. Prompting first loses early events
  // (including `session.idle`) and leaves the run waiting until the activity times out.
  const pumpPromise = pumpSegment({
    runId,
    adapter,
    handle,
    iterator: stream.iterator,
    signal: stream.controller.signal,
    fromSeq: args.fromSeq,
    decided: args.decided,
    ...(args.input.maxCostUsd !== undefined ? { maxCostUsd: args.input.maxCostUsd } : {}),
    deps: {
      append: (event) => appendEvent({ runId, stepId: 'stream', event }),
      recordPermission: (request) => recordPermissionRequest(request),
      isCancelled: () => isCancelRequested(runId),
      respond,
      heartbeat: (details) => heartbeat(details),
      sleep,
    },
  });

  // The prompt is sent exactly once per run. `startHarness` already created the session, so
  // `args.sessionRef` is always set on the first pump — keying off it silently skipped the
  // prompt and left a real-harness run streaming forever. The durable `prompt` step is the
  // marker: it survives activity retries and a worker restart (where the adapter session is
  // recreated and would otherwise be prompted twice).
  const agentDefinitions = agentDefinitionsFor(args.input);
  const activeAgent = args.input.agent
    ? agentDefinitions?.find((agent) => agent.name === args.input.agent)
    : undefined;
  const promptParts = promptPartsFor(args.input.prompt, activeAgent);
  const prompted = (await listSteps(runId)).some(
    (step) => (step as { step_id?: string }).step_id === 'prompt',
  );
  if (!prompted && promptParts.length > 0) {
    try {
      await adapter.sendPrompt(handle, promptParts, {
        ...(args.input.model ? { model: args.input.model } : {}),
        // Factory agent names are not harness agents; their instructions are in the prompt.
      });
      await upsertStep({
        runId,
        stepId: 'prompt',
        kind: 'harness',
        status: 'ok',
        detail: { parts: promptParts.length },
      });
    } catch (error) {
      dropStream(runId);
      await pumpPromise.catch(() => undefined);
      throw error;
    }
  }

  const segment = await pumpPromise;

  const droppedEvents = adapter.getStats?.().droppedEvents ?? 0;

  if (segment.stopReason === 'cancelled') {
    // Cooperative cancellation: stop the stream and let the workflow end the run.
    dropStream(runId);
  }

  if (segment.failure) {
    dropStream(runId);
    const failure = segment.failure;
    const code =
      failure instanceof AdapterError
        ? failure.code
        : typeof (failure as { code?: unknown })?.code === 'string'
          ? ((failure as { code: string }).code)
          : 'harness_error';
    const message = failure instanceof Error ? failure.message : String(failure);
    await upsertStep({
      runId,
      stepId: 'stream',
      kind: 'harness',
      status: 'error',
      error: `${code}: ${message}`,
    });
    throw Object.assign(new Error(message), { code });
  }

  if (segment.stopReason === 'terminal' || segment.stopReason === 'closed') {
    dropStream(runId);
  }

  const status: TerminalStatus | 'running' =
    segment.stopReason === 'cancelled'
      ? 'cancelled'
      : segment.stopReason === 'permission'
        ? 'running'
        : (segment.terminalStatus ?? 'ok');

  await upsertStep({
    runId,
    stepId: 'stream',
    kind: 'harness',
    status,
    detail: {
      appended: segment.appended,
      lastSeq: segment.lastSeq,
      droppedEvents,
      stopReason: segment.stopReason,
      permissionRequestId: segment.permissionRequestId ?? null,
    },
  });

  const terminalStatus: TerminalStatus | null =
    segment.stopReason === 'permission' || status === 'running' ? null : status;

  return {
    terminalStatus,
    terminalSummary: segment.terminalSummary,
    lastSeq: segment.lastSeq,
    appended: segment.appended,
    droppedEvents,
    costUsd: segment.costUsd,
    stopReason: segment.stopReason,
    permissionRequestId: segment.permissionRequestId,
    permissionAction: segment.permissionAction,
  };
}

/** Stops the harness session; safe to call when the session was never started. */
export async function cancelHarness(args: { input: RunInput; reason?: string }): Promise<void> {
  if (isRemoteRun(args.input)) {
    const remote = new RemoteRunnerBackend(loadConfig());
    await remote
      .sendForRunner(
        `factory-${args.input.runId}`,
        'cancel',
        { runId: args.input.runId, ...(args.reason ? { reason: args.reason } : {}) },
        60_000,
      )
      .catch(() => undefined);
    return;
  }
  const entry = getSession(args.input.runId);
  if (!entry) return;
  try {
    await entry.adapter.cancel(entry.handle, args.reason ?? 'cancelled');
  } catch {
    // the harness may already be gone; cancellation must still succeed
  }
}

/** Forwards a permission decision to the harness (used for adapters with direct APIs). */
export async function respondPermission(args: {
  input: RunInput;
  requestId: string;
  decision: 'allow' | 'deny' | 'always';
}): Promise<void> {
  if (isRemoteRun(args.input)) {
    const remote = new RemoteRunnerBackend(loadConfig());
    await remote.sendForRunner(
      `factory-${args.input.runId}`,
      'respond-permission',
      { runId: args.input.runId, requestId: args.requestId, decision: args.decision },
      60_000,
    );
    return;
  }
  const entry = getSession(args.input.runId);
  if (!entry) return;
  await entry.adapter.respondToPermission(entry.handle, args.requestId, args.decision);
}

/**
 * Builds the prompt parts for the first turn. Files are passed as sandbox paths; the adapter
 * resolves them inside the runner. A factory agent's instructions are prepended because
 * harness agents are not the factory's agents (opencode rejects `agent: "triage"`).
 */
function promptPartsFor(
  prompt: { text?: string; files?: string[] } | null | undefined,
  agent?: { name: string; description?: string; prompt: string },
): PromptPart[] {
  if (!prompt) return [];
  const parts: PromptPart[] = [];
  const preamble = agent
    ? `You are the "${agent.name}" agent in this factory.${agent.description ? ` ${agent.description}` : ''}\n\n${agent.prompt}`
    : '';
  const text = [preamble, prompt.text ?? ''].filter((part) => part.trim() !== '').join('\n\n---\n\n');
  if (text.trim() !== '') parts.push({ type: 'text', text });
  for (const file of prompt.files ?? []) parts.push({ type: 'file', path: file });
  return parts;
}
