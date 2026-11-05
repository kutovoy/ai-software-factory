import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FakeAdapter,
  OpencodeAdapter,
  isAdapterError,
  type AdapterStats,
  type FactoryEvent,
  type HarnessAdapter,
  type HarnessSessionStatus,
  type JsonValue,
  type McpSessionWiring,
  type PermissionDecision,
  type SessionHandle,
  type UsageReport,
} from '@factory/adapters';
import { DockerRunnerBackend } from './docker';
import { uploadArtifacts, type AgentArtifactUploadOptions } from './artifact-upload';
import { RunnerError } from './errors';
import { LocalRunnerBackend, powershellQuote } from './local';
import {
  normalizeRunnerSpec,
  type Artifact,
  type ArtifactRequest,
  type ExecEvent,
  type ExecRequest,
  type RunnerBackend,
  type RunnerHandle,
  type RunnerSpec,
} from './protocol';
import { toNodePlatform } from './remote-protocol';
import type {
  RemoteArtifactResult,
  RunnerCommandEnvelope,
  RemoteExecResult,
  RemotePumpPayload,
  RemotePumpResult,
  RemoteRunStartPayload,
  RemoteRunStartResult,
  RemoteSmokeResult,
  RunnerPreflightCheck,
  RunnerHostPlatform,
} from './remote-protocol';
import { runCommand } from './util';

/**
 * Local execution runtime for the remote runner agent.
 *
 * The agent is an executor: the control plane sends one command per step (`start-session`,
 * `pump`, `respond-permission`, `artifacts`, `kill`, …) and the agent runs the harness
 * adapter locally against a sandbox it owns. Canonical events travel back in the command
 * result; the central worker remains the single writer of the event log, so the agent
 * never assigns `seq` or persists anything.
 *
 * Jobs are keyed by `runId` (one harness session per run) and hold the live event
 * iterator. `pump` is therefore resumable: an unanswered `permission` stops the pump, and
 * the next `pump` (or `respond-permission`) continues from the same iterator, so a retried
 * command never loses or replays harness output.
 */

export interface AgentRuntimeOptions {
  agentVersion?: string;
  /**
   * Platform recorded at enrollment. The runtime maps it to `process.platform` so the
   * native backend, metrics and sandbox agree with what the console shows.
   */
  platform?: RunnerHostPlatform;
  /** Sandbox backend. `docker` is the production default; `local` is for dev/test hosts. */
  backend?: 'docker' | 'local';
  /** Docker network shared with the worker (containerised deployments). */
  network?: string;
  /** How the workspace reaches a docker sandbox (`bind` for host workers, `copy` in containers). */
  workspaceMode?: 'bind' | 'copy';
  allowedSecrets?: readonly string[];
  resolveSecret?: (name: string) => string | undefined;
  /** Parent directory for temp patch/artifact directories. Defaults to `os.tmpdir()`. */
  tempRoot?: string;
  /**
   * Optional object-store upload for collected artifacts (ADR-047). When set, the agent asks
   * the control plane for presigned PUT grants and uploads each blob; the inline patch is
   * kept either way. Absent → metadata-only collection (the existing behaviour).
   */
  artifactUpload?: AgentArtifactUploadOptions;
}

export interface AgentAdapterOptions {
  baseUrl?: string;
  password?: string;
  delayMs?: number;
}

/** Builds the harness adapter locally. The agent never imports orchestration code. */
export function createAdapterForAgent(
  harness: string,
  options: AgentAdapterOptions = {},
): HarnessAdapter {
  const name = harness.toLowerCase();
  if (name === 'opencode') {
    if (!options.baseUrl) {
      throw new RunnerError('runner_unavailable', 'opencode adapter requires a harness URL', {
        harness,
      });
    }
    return new OpencodeAdapter({
      baseUrl: options.baseUrl,
      ...(options.password ? { password: options.password } : {}),
    });
  }
  if (name === 'fake') {
    return new FakeAdapter({ delayMs: options.delayMs ?? 0 });
  }
  throw new RunnerError('runner_unavailable', `unsupported harness "${harness}"`, { harness });
}

/* -------------------------------------------------------------------------- */
/* Pump core                                                                  */
/* -------------------------------------------------------------------------- */

export const DEFAULT_PUMP_WAIT_MS = 10_000;

/** Mutable pump state, carried across `pump` calls for one run. */
export interface PumpState {
  /** Every event the agent has observed, in harness order. */
  events: FactoryEvent[];
  /** The in-flight `iterator.next()` promise, kept across calls when a pump times out. */
  pendingNext: Promise<IteratorResult<FactoryEvent>> | null;
  lastSeq: number;
  /** Cumulative cost reported by `usage.updated` so far (observability only). */
  costUsd?: number;
  /** Highest adapter dropped-event counter already reported to the control plane. */
  reportedDropped?: number;
  terminal: boolean;
  terminalStatus?: 'ok' | 'error' | 'cancelled' | null;
  terminalSummary?: string;
  permissionRequestId?: string;
  permissionAction?: string;
}

export interface PumpSource {
  next(): Promise<IteratorResult<FactoryEvent>>;
  respond(requestId: string, decision: PermissionDecision): Promise<void>;
  stats?(): AdapterStats;
  /**
   * Optional terminal-state probe used only when a pump window ends idle. A harness that
   * failed before the stream subscribed would otherwise never produce a terminal event.
   */
  status?(): Promise<HarnessSessionStatus | undefined>;
}

export interface PumpOptions {
  fromSeq?: number;
  decided?: Record<string, PermissionDecision>;
  waitMs?: number;
  signal?: AbortSignal;
  clock?: () => number;
}

/**
 * Drains the event iterator until a stop condition or `waitMs` elapses.
 *
 * Pure with respect to the transport: the caller supplies the iterator and the permission
 * responder, so the behaviour is testable without Docker, network or a harness process.
 * Never throws on a normal idle timeout; a stream failure is reported as a terminal error.
 */
export async function pumpJobEvents(
  state: PumpState,
  source: PumpSource,
  options: PumpOptions = {},
): Promise<RemotePumpResult> {
  const clock = options.clock ?? Date.now;
  const waitMs = Math.max(0, options.waitMs ?? DEFAULT_PUMP_WAIT_MS);
  const fromSeq = options.fromSeq ?? 0;
  const decided = options.decided ?? {};
  const deadline = clock() + waitMs;

  const build = (stopReason: RemotePumpResult['stopReason']): RemotePumpResult => {
    const events = state.events.filter((event) => event.seq > fromSeq);
    const result: RemotePumpResult = {
      events,
      stopReason,
      lastSeq: state.lastSeq,
    };
    if (state.terminalStatus !== undefined) result.terminalStatus = state.terminalStatus;
    if (state.terminalSummary !== undefined) result.terminalSummary = state.terminalSummary;

    // The control plane accumulates these per pump call, so report the delta carried by
    // *this* batch rather than the run total (which would be counted again on every poll).
    const batchCost = events.reduce(
      (sum, event) => (event.type === 'usage.updated' ? sum + (event.costUsd ?? 0) : sum),
      0,
    );
    if (batchCost > 0) result.costUsd = batchCost;

    const droppedTotal = source.stats?.().droppedEvents ?? 0;
    const droppedDelta = Math.max(0, droppedTotal - (state.reportedDropped ?? 0));
    state.reportedDropped = droppedTotal;
    if (droppedDelta > 0) result.droppedEvents = droppedDelta;

    if (state.permissionRequestId !== undefined) {
      result.permissionRequestId = state.permissionRequestId;
    }
    if (state.permissionAction !== undefined) result.permissionAction = state.permissionAction;
    return result;
  };

  if (state.terminal) return build('terminal');

  // A permission stop from a previous pump: answer it if the control plane decided, or
  // report it again immediately instead of blocking on an iterator that cannot advance.
  if (state.permissionRequestId !== undefined) {
    const decision = decided[state.permissionRequestId];
    if (!decision) return build('permission');
    await source.respond(state.permissionRequestId, decision);
    state.permissionRequestId = undefined;
    state.permissionAction = undefined;
  }

  while (true) {
    if (options.signal?.aborted) return build('cancelled');

    const remaining = deadline - clock();
    if (remaining <= 0) return build('idle');

    const pending = state.pendingNext ?? source.next();
    state.pendingNext = pending;

    let outcome: IteratorResult<FactoryEvent> | 'timeout' | 'aborted';
    try {
      outcome = await raceOutcome(pending, remaining, options.signal);
    } catch (error) {
      // A broken harness stream ends the run; it must not crash the agent loop.
      state.pendingNext = null;
      state.terminal = true;
      state.terminalStatus = 'error';
      state.terminalSummary = errorMessage(error);
      return build('terminal');
    }
    if (outcome === 'aborted') return build('cancelled');
    if (outcome === 'timeout') {
      // The event stream may have gone quiet because the harness failed before the
      // adapter subscribed. Ask the harness for its terminal outcome; if it has one,
      // close the run instead of idling forever.
      if (source.status) {
        const status = await source.status().catch(() => undefined);
        if (status?.terminal) {
          state.terminal = true;
          state.terminalStatus = status.status ?? 'error';
          if (status.summary !== undefined) state.terminalSummary = status.summary;
          return build('terminal');
        }
      }
      return build('idle');
    }

    state.pendingNext = null;

    if (outcome.done) return build('closed');

    const event = outcome.value;
    state.events.push(event);
    if (event.seq > state.lastSeq) state.lastSeq = event.seq;

    if (event.type === 'usage.updated' && typeof event.costUsd === 'number') {
      state.costUsd = event.costUsd;
    }

    if (event.type === 'run.completed') {
      state.terminal = true;
      state.terminalStatus = event.status;
      if (event.summary !== undefined) state.terminalSummary = event.summary;
      return build('terminal');
    }

    if (event.type === 'permission.requested') {
      const decision = decided[event.requestId];
      if (decision) {
        // The control plane already decided this request: answer and keep draining so the
        // harness can proceed inside the same pump call.
        await source.respond(event.requestId, decision);
        continue;
      }
      state.permissionRequestId = event.requestId;
      state.permissionAction = event.action;
      return build('permission');
    }
  }
}

/**
 * Races an iterator result against a timeout and an abort signal without leaking timers.
 * The losing `next()` promise is intentionally kept alive by the caller.
 */
function raceOutcome<T>(
  promise: Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T | 'timeout' | 'aborted'> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const finish = (value: T | 'timeout' | 'aborted'): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onAbort = (): void => finish('aborted');

    timer = setTimeout(() => finish('timeout'), Math.max(0, timeoutMs));
    signal?.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => finish(value),
      (error: unknown) => fail(error),
    );
  });
}

/* -------------------------------------------------------------------------- */
/* Runtime                                                                    */
/* -------------------------------------------------------------------------- */

interface AgentJob extends PumpState {
  runId: string;
  runnerId: string;
  adapter: HarnessAdapter;
  session: SessionHandle;
  backend: RunnerBackend;
  iterator: AsyncIterator<FactoryEvent>;
  controller: AbortController;
}

export class RunnerAgentRuntime {
  readonly agentVersion: string;

  private readonly backend: RunnerBackend;
  private readonly tempRoot: string;
  private readonly platform: NodeJS.Platform;
  private readonly artifactUpload?: AgentArtifactUploadOptions;
  private readonly jobs = new Map<string, AgentJob>();

  constructor(options: AgentRuntimeOptions = {}) {
    this.agentVersion = options.agentVersion ?? '0.0.0';
    this.tempRoot = options.tempRoot ?? tmpdir();
    this.platform = options.platform ? toNodePlatform(options.platform) : process.platform;
    this.artifactUpload = options.artifactUpload;

    const shared = {
      ...(options.allowedSecrets ? { allowedSecrets: options.allowedSecrets } : {}),
      ...(options.resolveSecret ? { resolveSecret: options.resolveSecret } : {}),
    };
    this.backend =
      options.backend === 'local'
        ? new LocalRunnerBackend({ ...shared, platform: this.platform })
        : new DockerRunnerBackend({
            ...shared,
            ...(options.network ? { network: options.network } : {}),
            ...(options.workspaceMode ? { workspaceMode: options.workspaceMode } : {}),
          });
  }

  /** Number of live sessions (sandboxes) this agent is running. */
  leases(): number {
    return this.jobs.size;
  }

  /**
   * Kills every live session and its sandbox. Called on agent shutdown so a SIGTERM does
   * not leave an `opencode serve` child (or a Docker container) behind.
   */
  async shutdown(): Promise<void> {
    const runnerIds = [...new Set([...this.jobs.values()].map((job) => job.runnerId))];
    await Promise.all(
      runnerIds.map((runnerId) => this.kill(runnerId).catch(() => undefined)),
    );
  }

  /** Dispatches one command from the control plane. Errors surface as thrown values. */
  async execute(command: RunnerCommandEnvelope): Promise<unknown> {
    switch (command.type) {
      case 'lease':
        return this.lease(readLeaseSpec(command.payload));
      case 'exec':
        return this.exec(readExecPayload(command.payload));
      case 'start-session':
        return this.startSession(readStartPayload(command.payload));
      case 'pump':
        return this.pump(readPumpPayload(command.payload));
      case 'respond-permission':
        return this.respondPermission(readRespondPayload(command.payload));
      case 'artifacts':
        return this.collectArtifacts(readArtifactsPayload(command.payload));
      case 'kill':
        return this.kill(readRunnerId(command.payload));
      case 'cancel':
        return this.cancel(readCancelPayload(command.payload));
      case 'smoke-test':
        return this.smokeTest(command.payload);
      default:
        throw new RunnerError('invalid_spec', `unsupported command type "${command.type}"`, {
          type: command.type,
        });
    }
  }

  /* ------------------------------------------------------------------------ */

  private async lease(spec: RunnerSpec): Promise<RunnerHandle> {
    const normalized = normalizeRunnerSpec(spec);
    // The central worker sends a diff body, not a path it can read from this host.
    const patchDir = normalized.repo?.patchContent
      ? await this.createTempDir('patch-')
      : undefined;
    if (patchDir && normalized.repo?.patchContent) {
      const patchPath = join(patchDir, 'patch.diff');
      await writeFile(patchPath, normalized.repo.patchContent, 'utf8');
      normalized.repo = { ...normalized.repo, patch: patchPath };
    }
    try {
      return await this.backend.lease(normalized);
    } finally {
      if (patchDir) await rm(patchDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async exec(input: { runnerId: string; request: ExecRequest }): Promise<RemoteExecResult> {
    const events: ExecEvent[] = [];
    for await (const event of this.backend.exec(input.runnerId, input.request)) {
      events.push(event);
    }
    return { events };
  }

  private async startSession(payload: RemoteRunStartPayload): Promise<RemoteRunStartResult> {
    if (!payload || typeof payload !== 'object' || typeof payload.runId !== 'string') {
      throw new RunnerError('invalid_spec', 'start-session requires a runId');
    }
    if (typeof payload.runnerId !== 'string' || payload.runnerId.trim() === '') {
      throw new RunnerError('invalid_spec', 'start-session requires a runnerId', {
        runId: payload.runId,
      });
    }

    const harnessEnv = payload.harnessEnv ?? {};
    const password = harnessEnv.OPENCODE_SERVER_PASSWORD;

    // The stage patch is a wire payload, not a host path: materialise it once, let the
    // backend apply it during checkout, then remove it — the sandbox never sees it.
    const patchDir = payload.repo?.patchContent
      ? await this.createTempDir('patch-')
      : undefined;
    const patchPath = patchDir ? join(patchDir, 'patch.diff') : undefined;
    if (patchPath && payload.repo?.patchContent) {
      await writeFile(patchPath, payload.repo.patchContent, 'utf8');
    }

    const spec: RunnerSpec = {
      runId: payload.runId,
      runnerId: payload.runnerId,
      harness: {
        command: payload.harnessCommand,
        port: payload.harnessPort,
        readyPath: payload.readyPath,
        // The proxy env is already baked into `harnessCommand`; do not put OPENAI_* into
        // `env`/`harness.env` or the runner's inference-credential guard rejects the lease.
        ...(password && payload.harness === 'opencode'
          ? { headers: { authorization: basicAuthHeader(password) } }
          : {}),
      },
      secrets: payload.secrets ?? [],
      networkPolicy: payload.networkPolicy ?? 'denied',
      readyTimeoutMs: payload.readyTimeoutMs,
      keepWorkspace: false,
      ...(payload.workspace ? { workspace: payload.workspace } : {}),
      ...(payload.runDir ? { runDir: payload.runDir } : {}),
      ...(payload.repo
        ? {
            repo: {
              ...(payload.repo.url ? { url: payload.repo.url } : {}),
              ...(payload.repo.path ? { path: payload.repo.path } : {}),
              ...(payload.repo.commit ? { commit: payload.repo.commit } : {}),
              ...(patchPath ? { patch: patchPath } : {}),
            },
          }
        : {}),
    };

    let handle: RunnerHandle;
    try {
      handle = await this.backend.lease(spec);
    } finally {
      if (patchDir) await rm(patchDir, { recursive: true, force: true }).catch(() => undefined);
    }

    const adapter = createAdapterForAgent(payload.harness, {
      baseUrl: handle.harnessUrl,
      ...(password ? { password } : {}),
      ...(payload.fakeDelayMs !== undefined ? { delayMs: payload.fakeDelayMs } : {}),
    });

    let session: SessionHandle;
    const title = metadataTitle(payload.metadata);
    try {
      session = await adapter.startSession({
        runId: payload.runId,
        ...(payload.model ? { model: payload.model } : {}),
        ...(title ? { title } : {}),
        workspace: handle.workspace,
        ...(payload.agents ? { agents: payload.agents } : {}),
        ...(payload.mcp ? { mcp: payload.mcp as McpSessionWiring } : {}),
        ...(payload.metadata ? { metadata: payload.metadata as Record<string, JsonValue> } : {}),
      });
    } catch (error) {
      await this.backend.kill(payload.runnerId).catch(() => undefined);
      throw error;
    }

    const controller = new AbortController();
    // Start the iterator before sending the prompt so no early harness event is missed.
    const iterator = adapter.streamEvents(session, controller.signal)[Symbol.asyncIterator]();

    const job: AgentJob = {
      runId: payload.runId,
      runnerId: payload.runnerId,
      adapter,
      session,
      backend: this.backend,
      iterator,
      controller,
      events: [],
      pendingNext: null,
      lastSeq: 0,
      terminal: false,
    };
    this.jobs.set(payload.runId, job);

    try {
      await adapter.sendPrompt(session, payload.promptParts ?? []);
    } catch (error) {
      controller.abort();
      this.jobs.delete(payload.runId);
      await adapter.dispose(session).catch(() => undefined);
      await this.backend.kill(payload.runnerId).catch(() => undefined);
      throw error;
    }

    return {
      runnerId: payload.runnerId,
      harnessUrl: handle.harnessUrl,
      ...(session.sessionRef ? { sessionRef: session.sessionRef } : {}),
      capabilities: adapter.capabilities,
      ...(payload.mcp ? { mcp: payload.mcp } : {}),
    };
  }

  private async pump(payload: RemotePumpPayload): Promise<RemotePumpResult> {
    const job = this.requireJob(payload?.runId);
    return pumpJobEvents(job, this.pumpSource(job), {
      ...(payload.fromSeq !== undefined ? { fromSeq: payload.fromSeq } : {}),
      ...(payload.decided ? { decided: payload.decided } : {}),
      ...(payload.waitMs !== undefined ? { waitMs: payload.waitMs } : {}),
      signal: job.controller.signal,
    });
  }

  private async respondPermission(input: {
    runId: string;
    requestId: string;
    decision: PermissionDecision;
  }): Promise<void> {
    const job = this.requireJob(input.runId);
    if (typeof input.requestId !== 'string' || input.requestId === '') {
      throw new RunnerError('invalid_spec', 'respond-permission requires a requestId', {
        runId: input.runId,
      });
    }
    try {
      await job.adapter.respondToPermission(job.session, input.requestId, input.decision);
    } catch (error) {
      // A request that already resolved (or expired) is not an agent failure.
      if (isAdapterError(error) && error.code === 'permission_not_found') return;
      throw error;
    }
    if (job.permissionRequestId === input.requestId) {
      job.permissionRequestId = undefined;
      job.permissionAction = undefined;
    }
  }

  private async collectArtifacts(input: {
    runnerId: string;
    runId?: string;
    request: ArtifactRequest;
  }): Promise<RemoteArtifactResult> {
    const destDir = await this.createTempDir('artifacts-');
    try {
      let artifacts: Artifact[] = await this.backend.artifacts(input.runnerId, {
        ...input.request,
        destDir,
        includeGitDiff: true,
      });

      const patch = await readFile(join(destDir, 'patch.diff'), 'utf8').catch(() => undefined);

      let usage: UsageReport | null | undefined;
      const job = this.jobForRunner(input.runnerId);
      if (job) {
        usage = await job.adapter.getUsage(job.session).catch(() => null);
      }

      const uploadErrors: string[] = [];
      if (this.artifactUpload && artifacts.length > 0) {
        const runId = input.runId ?? job?.runId ?? runIdFromRunnerId(input.runnerId);
        try {
          const uploaded = await uploadArtifacts(
            artifacts,
            { runnerId: input.runnerId, runId, destDir },
            this.artifactUpload,
          );
          artifacts = uploaded.artifacts;
          uploadErrors.push(...uploaded.uploadErrors);
        } catch (error) {
          // Upload must never lose the collected metadata or the inline patch.
          uploadErrors.push(`artifact upload failed: ${errorMessage(error)}`);
        }
      }

      return {
        artifacts,
        ...(patch !== undefined ? { patch } : {}),
        ...(usage !== undefined ? { usage } : {}),
        ...(uploadErrors.length > 0 ? { uploadErrors } : {}),
      };
    } finally {
      await rm(destDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async kill(runnerId: string): Promise<void> {
    if (typeof runnerId !== 'string' || runnerId === '') {
      throw new RunnerError('invalid_spec', 'kill requires a runnerId');
    }

    const job = this.jobForRunner(runnerId);
    if (job) {
      this.jobs.delete(job.runId);
      job.controller.abort();
      await job.adapter.cancel(job.session, 'kill').catch(() => undefined);
      await job.adapter.dispose(job.session).catch(() => undefined);
    }

    // Idempotent: the backend re-attaches by name, so a repeated kill is a no-op.
    await this.backend.kill(runnerId);
  }

  private async cancel(input: { runId: string; reason?: string }): Promise<void> {
    const job = this.jobs.get(input.runId);
    if (!job) return; // already terminal or killed: cancellation is a no-op

    await job.adapter.cancel(job.session, input.reason).catch(() => undefined);
    job.controller.abort();
  }

  private async smokeTest(payload: unknown): Promise<RemoteSmokeResult> {
    const record = asRecord(payload);
    const apiUrl =
      typeof record.apiUrl === 'string'
        ? record.apiUrl
        : (process.env.FACTORY_API_URL ?? undefined);

    const checks: Record<string, RunnerPreflightCheck> = {};

    if (this.backend.kind === 'docker') {
      const docker = await runCommand(['docker', 'version', '--format', '{{.Server.Version}}'], {
        timeoutMs: 10_000,
      }).catch(() => undefined);
      checks.docker =
        docker && docker.code === 0
          ? { ok: true, detail: docker.stdout.trim() }
          : { ok: false, detail: docker?.stderr.slice(-500) || 'docker CLI/server unavailable' };
    } else {
      checks.docker = { ok: true, detail: 'local backend: docker is not required' };
    }

    const git = await runCommand(['git', '--version'], { timeoutMs: 5_000 }).catch(() => undefined);
    checks.git =
      git && git.code === 0
        ? { ok: true, detail: git.stdout.trim() }
        : { ok: false, detail: 'git is not available' };

    checks.disk = await this.probeDisk();

    if (apiUrl) checks.api = await probeApi(apiUrl);

    const ok = Object.values(checks).every((check) => check.ok);
    return { ok, checks };
  }

  private async probeDisk(): Promise<RunnerPreflightCheck> {
    try {
      await mkdir(this.tempRoot, { recursive: true });
      const availableBytes =
        this.platform === 'win32'
          ? await windowsFreeBytes(this.tempRoot)
          : await posixFreeBytes(this.tempRoot);
      if (availableBytes === undefined) {
        return { ok: false, detail: `free disk space could not be read at ${this.tempRoot}` };
      }
      const minFreeBytes = 512 * 1024 * 1024;
      return availableBytes >= minFreeBytes
        ? { ok: true, detail: `${availableBytes} bytes free at ${this.tempRoot}` }
        : { ok: false, detail: `only ${availableBytes} bytes free at ${this.tempRoot}` };
    } catch (error) {
      return { ok: false, detail: errorMessage(error) };
    }
  }

  /* ------------------------------------------------------------------------ */

  private pumpSource(job: AgentJob): PumpSource {
    return {
      next: () => job.iterator.next(),
      respond: (requestId, decision) => job.adapter.respondToPermission(job.session, requestId, decision),
      stats: () => job.adapter.getStats?.() ?? { droppedEvents: 0, emittedEvents: 0 },
      ...(job.adapter.getStatus
        ? { status: () => job.adapter.getStatus?.(job.session) ?? Promise.resolve(undefined) }
        : {}),
    };
  }

  private requireJob(runId: string | undefined): AgentJob {
    if (typeof runId !== 'string' || runId === '') {
      throw new RunnerError('invalid_spec', 'command requires a runId');
    }
    const job = this.jobs.get(runId);
    if (!job) {
      throw new RunnerError('runner_not_found', `no session for run ${runId}`, { runId });
    }
    return job;
  }

  private jobForRunner(runnerId: string): AgentJob | undefined {
    for (const job of this.jobs.values()) {
      if (job.runnerId === runnerId) return job;
    }
    return undefined;
  }

  private async createTempDir(prefix: string): Promise<string> {
    await mkdir(this.tempRoot, { recursive: true });
    return mkdtemp(join(this.tempRoot, prefix));
  }
}

/* -------------------------------------------------------------------------- */
/* Payload readers                                                            */
/* -------------------------------------------------------------------------- */

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function readLeaseSpec(payload: unknown): RunnerSpec {
  const record = asRecord(payload);
  return (record.spec ?? payload) as RunnerSpec;
}

function readExecPayload(payload: unknown): { runnerId: string; request: ExecRequest } {
  const record = asRecord(payload);
  const request = (record.request ?? payload) as ExecRequest & { runnerId?: string };
  const runnerId = typeof record.runnerId === 'string' ? record.runnerId : request.runnerId;
  if (typeof runnerId !== 'string' || runnerId === '') {
    throw new RunnerError('invalid_spec', 'exec requires a runnerId');
  }
  return { runnerId, request };
}

function readStartPayload(payload: unknown): RemoteRunStartPayload {
  const record = asRecord(payload);
  return (record.request ?? payload) as RemoteRunStartPayload;
}

function readPumpPayload(payload: unknown): RemotePumpPayload {
  const record = asRecord(payload);
  return (record.request ?? payload) as RemotePumpPayload;
}

function readRespondPayload(payload: unknown): {
  runId: string;
  requestId: string;
  decision: PermissionDecision;
} {
  const record = asRecord(payload);
  const source = asRecord(record.request ?? payload);
  const runId = typeof source.runId === 'string' ? source.runId : '';
  const requestId = typeof source.requestId === 'string' ? source.requestId : '';
  const decision = source.decision;
  if (typeof runId !== 'string' || runId === '') {
    throw new RunnerError('invalid_spec', 'respond-permission requires a runId');
  }
  if (typeof requestId !== 'string' || requestId === '') {
    throw new RunnerError('invalid_spec', 'respond-permission requires a requestId', { runId });
  }
  if (decision !== 'allow' && decision !== 'deny' && decision !== 'always') {
    throw new RunnerError('invalid_spec', `invalid permission decision "${String(decision)}"`, {
      runId,
      requestId,
    });
  }
  return { runId, requestId, decision };
}

function readArtifactsPayload(payload: unknown): {
  runnerId: string;
  runId?: string;
  request: ArtifactRequest;
} {
  const record = asRecord(payload);
  const request = (record.request ?? payload) as ArtifactRequest;
  const runnerId = typeof record.runnerId === 'string' ? record.runnerId : '';
  if (runnerId === '') {
    throw new RunnerError('invalid_spec', 'artifacts requires a runnerId');
  }
  return {
    runnerId,
    ...(typeof record.runId === 'string' && record.runId !== '' ? { runId: record.runId } : {}),
    request,
  };
}

/** Fallback when the command omits `runId`: the default runner id is `factory-<runId>`. */
function runIdFromRunnerId(runnerId: string): string {
  return runnerId.startsWith('factory-') ? runnerId.slice('factory-'.length) : runnerId;
}

function readRunnerId(payload: unknown): string {
  const record = asRecord(payload);
  const runnerId = record.runnerId;
  if (typeof runnerId !== 'string' || runnerId === '') {
    throw new RunnerError('invalid_spec', 'kill requires a runnerId');
  }
  return runnerId;
}

function readCancelPayload(payload: unknown): { runId: string; reason?: string } {
  const record = asRecord(payload);
  const source = asRecord(record.request ?? payload);
  const runId = typeof source.runId === 'string' ? source.runId : '';
  if (runId === '') {
    throw new RunnerError('invalid_spec', 'cancel requires a runId');
  }
  return {
    runId,
    ...(typeof source.reason === 'string' ? { reason: source.reason } : {}),
  };
}

function metadataTitle(metadata: Record<string, unknown> | undefined): string | undefined {
  const title = metadata?.title;
  return typeof title === 'string' && title.trim() !== '' ? title : undefined;
}

function basicAuthHeader(password: string): string {
  return `Basic ${Buffer.from(`opencode:${password}`, 'utf8').toString('base64')}`;
}

/** `df -Pk <path>` free bytes on POSIX. */
async function posixFreeBytes(path: string): Promise<number | undefined> {
  const result = await runCommand(['df', '-Pk', path], { timeoutMs: 5_000 }).catch(() => undefined);
  if (!result || result.code !== 0) return undefined;
  const line = result.stdout.trim().split('\n').at(-1) ?? '';
  const fields = line.trim().split(/\s+/);
  const availableKb = Number.parseInt(fields[3] ?? '', 10);
  return Number.isFinite(availableKb) ? availableKb * 1024 : undefined;
}

/** Windows has no `df`: ask PowerShell for the free space of the temp directory's drive. */
async function windowsFreeBytes(path: string): Promise<number | undefined> {
  const script = `(Get-PSDrive -Name ((Get-Item -LiteralPath ${powershellQuote(path)}).PSDrive.Name)).Free`;
  const result = await runCommand(
    ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', script],
    { timeoutMs: 10_000 },
  ).catch(() => undefined);
  if (!result || result.code !== 0) return undefined;
  const availableBytes = Number.parseInt(result.stdout.trim(), 10);
  return Number.isFinite(availableBytes) ? availableBytes : undefined;
}

async function probeApi(apiUrl: string): Promise<RunnerPreflightCheck> {
  const base = apiUrl.replace(/\/$/, '');
  try {
    const response = await fetch(`${base}/health`, {
      signal: AbortSignal.timeout(5_000),
    });
    return response.ok
      ? { ok: true, detail: `${base}/health answered ${response.status}` }
      : { ok: false, detail: `${base}/health answered ${response.status}` };
  } catch (error) {
    return { ok: false, detail: errorMessage(error) };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
