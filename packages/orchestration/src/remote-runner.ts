import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  RunnerError,
  normalizeRunnerSpec,
  type Artifact,
  type ArtifactRequest,
  type ExecEvent,
  type ExecRequest,
  type RunnerBackend,
  type RunnerCommandType,
  type RunnerHandle,
  type RunnerHeartbeat,
  type RunnerSpec,
} from '@factory/runners';
import type { OrchestrationConfig } from './config';
import {
  createLease,
  enqueueCommand,
  getLeaseByRunnerId,
  releaseLease,
  selectHost,
  waitForCommand,
} from './runner-hosts';

/**
 * Remote runner backend: the same `RunnerBackend` contract, but every call becomes a
 * command for a host agent. The agent runs the sandbox and harness adapter locally; the
 * central worker remains the only writer of the event log and the only Temporal client.
 *
 * The backend is deliberately thin. Host selection, lease reservation and the command
 * queue live in `runner-hosts.ts`; the wire payloads live in
 * `@factory/runners/remote-protocol`.
 */
export class RemoteRunnerBackend implements RunnerBackend {
  readonly kind = 'remote' as const;

  private readonly config: OrchestrationConfig;
  private readonly hosts = new Map<string, string>();

  constructor(config: OrchestrationConfig) {
    this.config = config;
  }

  async lease(input: RunnerSpec): Promise<RunnerHandle> {
    const spec = normalizeRunnerSpec(input);
    if (!spec.repo?.url) {
      throw new RunnerError(
        'remote_repo_url_required',
        'remote runs need a clone URL; the central host path is not visible to the agent',
        { runnerId: spec.runnerId, runId: spec.runId },
      );
    }

    const host = await selectHost({
      platform: spec.platform ?? this.config.remoteRunnerPlatform,
      pool: spec.pool ?? this.config.remoteRunnerPool,
      labels: spec.labels ?? {},
      tenant: spec.tenant ?? 'default',
    });
    if (!host) {
      throw new RunnerError(
        'no_matching_runner',
        `no remote runner matches platform=${spec.platform ?? this.config.remoteRunnerPlatform} pool=${spec.pool ?? this.config.remoteRunnerPool}`,
        { runnerId: spec.runnerId, runId: spec.runId },
      );
    }

    const lease = await createLease({
      hostId: host.id,
      runId: spec.runId,
      runnerId: spec.runnerId,
      ttlMs: this.config.remoteLeaseTtlMs,
    });
    this.hosts.set(spec.runnerId, host.id);

    try {
      const result = await this.send(host.id, 'lease', { spec }, this.config.remoteCommandTimeoutMs);
      const handle = result as RunnerHandle;
      return {
        ...handle,
        kind: 'remote',
      };
    } catch (error) {
      await releaseLease(spec.runnerId).catch(() => undefined);
      this.hosts.delete(spec.runnerId);
      throw error;
    }
  }

  async *exec(runnerId: string, request: ExecRequest): AsyncIterable<ExecEvent> {
    const hostId = await this.hostFor(runnerId);
    const result = (await this.send(
      hostId,
      'exec',
      { runnerId, request: stripSignal(request) },
      request.timeoutMs ? request.timeoutMs + 30_000 : this.config.remoteCommandTimeoutMs,
    )) as { events: ExecEvent[] };
    for (const event of result.events) yield event;
  }

  async heartbeat(runnerId: string): Promise<RunnerHeartbeat> {
    const hostId = await this.hostFor(runnerId).catch(() => null);
    return {
      runnerId,
      alive: hostId !== null,
      kind: 'remote',
    };
  }

  async artifacts(runnerId: string, request: ArtifactRequest): Promise<Artifact[]> {
    return (await this.collect(runnerId, request)).artifacts;
  }

  /** Artifact collection plus the usage report and upload errors the agent reported. */
  async collect(
    runnerId: string,
    request: ArtifactRequest,
  ): Promise<{ artifacts: Artifact[]; usage: unknown | null; uploadErrors: string[] }> {
    const hostId = await this.hostFor(runnerId);
    const lease = await getLeaseByRunnerId(runnerId);
    const result = (await this.send(
      hostId,
      'artifacts',
      {
        runnerId,
        ...(lease ? { runId: lease.runId } : {}),
        request: { ...request, destDir: request.destDir },
      },
      this.config.remoteCommandTimeoutMs,
    )) as { artifacts: Artifact[]; patch?: string; usage?: unknown; uploadErrors?: unknown };

    // The agent returns the patch body for downstream stages; blobs are uploaded to the
    // artifact store by the agent (ADR-047), so only metadata travels through the queue.
    if (typeof result.patch === 'string') {
      const patchFile = join(request.destDir, 'patch.diff');
      await mkdir(dirname(patchFile), { recursive: true });
      await writeFile(patchFile, result.patch, 'utf8');
    }
    return {
      artifacts: result.artifacts ?? [],
      usage: result.usage ?? null,
      uploadErrors: Array.isArray(result.uploadErrors)
        ? result.uploadErrors.filter((entry): entry is string => typeof entry === 'string')
        : [],
    };
  }

  async kill(runnerId: string): Promise<void> {
    const lease = await getLeaseByRunnerId(runnerId);
    if (!lease) {
      this.hosts.delete(runnerId);
      return;
    }
    try {
      await this.send(lease.hostId, 'kill', { runnerId }, this.config.remoteCommandTimeoutMs);
    } finally {
      await releaseLease(runnerId).catch(() => undefined);
      this.hosts.delete(runnerId);
    }
  }

  /** Sends a command to the host currently owning `runnerId` (used by harness activities). */
  async sendForRunner(
    runnerId: string,
    type: 'start-session' | 'pump' | 'respond-permission' | 'cancel',
    payload: unknown,
    timeoutMs?: number,
  ): Promise<unknown> {
    const hostId = await this.hostFor(runnerId);
    return this.send(hostId, type, payload, timeoutMs ?? this.config.remoteCommandTimeoutMs);
  }

  private async hostFor(runnerId: string): Promise<string> {
    const cached = this.hosts.get(runnerId);
    if (cached) return cached;
    const lease = await getLeaseByRunnerId(runnerId);
    if (!lease) {
      throw new RunnerError('runner_not_found', `no remote lease for runner ${runnerId}`, {
        runnerId,
      });
    }
    this.hosts.set(runnerId, lease.hostId);
    return lease.hostId;
  }

  private async send(
    hostId: string,
    type: RunnerCommandType,
    payload: unknown,
    timeoutMs: number,
  ): Promise<unknown> {
    const { commandId } = await enqueueCommand({ hostId, type, payload, timeoutMs });
    const result = await waitForCommand(commandId, timeoutMs);
    if (!result.ok) {
      throw new RunnerError(
        (result.error?.code as never) ?? 'runner_unavailable',
        result.error?.message ?? `remote command ${type} failed`,
      );
    }
    return result.result;
  }
}

/** AbortSignal is not serialisable; the agent enforces the timeout from `timeoutMs`. */
function stripSignal(request: ExecRequest): Omit<ExecRequest, 'signal'> {
  const { signal: _signal, ...rest } = request;
  return rest;
}

/**
 * A remote lease is represented by `kind: remote` in the read model. The agent still uses
 * a Docker/local sandbox internally; only the transport is remote.
 */
export function isRemoteRun(input: { runner: string }): boolean {
  return input.runner === 'remote';
}
