import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { RunnerError } from './errors';
import {
  DEFAULT_HARNESS_COMMAND,
  normalizeRunnerSpec,
  type Artifact,
  type ArtifactRequest,
  type ExecEvent,
  type ExecRequest,
  type RunnerBackend,
  type RunnerHandle,
  type RunnerHeartbeat,
  type RunnerSpec,
} from './protocol';
import {
  assertNoInferenceEnv,
  resolveSecrets,
  sanitizeHostEnv,
  scrubSecrets,
  type ResolvedSecret,
} from './secrets';
import {
  copyFromWorkspace,
  freePort,
  hashArtifacts,
  prepareWorkspace,
  removeDir,
  sleep,
  streamCommand,
  waitForReady,
  writePatch,
} from './util';

export interface LocalRunnerOptions {
  allowedSecrets?: readonly string[];
  resolveSecret?: (name: string) => string | undefined | Promise<string | undefined>;
  readyTimeoutMs?: number;
  /** Extra env for the harness process. */
  harnessEnv?: Record<string, string>;
  shell?: string;
}

interface LocalLease {
  handle: RunnerHandle;
  workspace: string;
  keepWorkspace: boolean;
  secrets: ResolvedSecret[];
  child?: ChildProcess;
  startedAt: number;
  stderr: string;
}

/**
 * Process-based fallback: same protocol as the docker backend, no Docker.
 *
 * Used for fast tests and dev machines without Docker. It is **not** a security
 * boundary: the process runs on the host, so inference credentials are stripped from
 * the inherited environment and only allowlisted execution secrets are injected.
 * macOS `sandbox-exec` isolation is not implemented yet (see README).
 */
export class LocalRunnerBackend implements RunnerBackend {
  readonly kind = 'local' as const;

  private readonly allowedSecrets: readonly string[] | undefined;
  private readonly resolveSecret: LocalRunnerOptions['resolveSecret'];
  private readonly readyTimeoutMs: number;
  private readonly harnessEnv: Record<string, string>;
  private readonly shell: string;
  private readonly leases = new Map<string, LocalLease>();

  constructor(options: LocalRunnerOptions = {}) {
    this.allowedSecrets = options.allowedSecrets;
    this.resolveSecret = options.resolveSecret;
    this.readyTimeoutMs = options.readyTimeoutMs ?? 30_000;
    this.harnessEnv = options.harnessEnv ?? {};
    this.shell = options.shell ?? '/bin/sh';
  }

  async lease(input: RunnerSpec): Promise<RunnerHandle> {
    const spec = normalizeRunnerSpec(input);
    assertNoInferenceEnv(spec.env);
    assertNoInferenceEnv(spec.harness.env);

    const secrets: ResolvedSecret[] = await resolveSecrets(spec.secrets, {
      allowedSecrets: this.allowedSecrets,
      resolve: this.resolveSecret,
    });

    const existing = this.leases.get(spec.runnerId);
    if (existing && this.isAlive(existing)) return existing.handle;

    const workspace = await prepareWorkspace(spec.repo, spec.workspace);
    const port = await freePort();

    const env: Record<string, string> = {
      ...sanitizeHostEnv(process.env),
      ...this.harnessEnv,
      ...spec.harness.env,
      ...spec.env,
      PORT: String(port),
    };
    for (const secret of secrets) env[secret.name] = secret.value;

    const command = this.harnessCommand(spec.harness.command, port);
    const child = spawn(this.shell, ['-c', command], {
      cwd: workspace,
      env: env as NodeJS.ProcessEnv,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';
    child.stdout?.on('data', () => undefined);
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString('utf8')}`.slice(-4000);
    });

    const handle: RunnerHandle = {
      runnerId: spec.runnerId,
      kind: this.kind,
      workspace,
      harnessUrl: `http://127.0.0.1:${port}`,
      port,
      pid: child.pid,
    };

    try {
      await waitForReady({
        url: handle.harnessUrl,
        readyPath: spec.harness.readyPath,
        timeoutMs: spec.readyTimeoutMs || this.readyTimeoutMs,
      });
    } catch (error) {
      await this.terminate(child);
      await removeDir(workspace).catch(() => undefined);
      throw new RunnerError(
        'runner_unavailable',
        error instanceof Error ? error.message : String(error),
        { runnerId: spec.runnerId, command, stderr },
      );
    }

    this.leases.set(spec.runnerId, {
      handle,
      workspace,
      keepWorkspace: spec.keepWorkspace ?? false,
      secrets,
      child,
      startedAt: Date.now(),
      stderr,
    });

    return handle;
  }

  async *exec(runnerId: string, req: ExecRequest): AsyncIterable<ExecEvent> {
    const lease = this.leases.get(runnerId);
    if (!lease) {
      yield { type: 'error', code: 'runner_not_found', message: `no sandbox for ${runnerId}` };
      return;
    }

    const env: Record<string, string> = {
      ...sanitizeHostEnv(process.env),
    };
    for (const secret of lease.secrets) env[secret.name] = secret.value;
    Object.assign(env, req.env ?? {});

    const command = Array.isArray(req.command)
      ? [this.shell, '-c', req.command.map(shellQuote).join(' ')]
      : [this.shell, '-c', req.command];

    for await (const event of streamCommand(command, {
      cwd: req.cwd ?? lease.workspace,
      env,
      timeoutMs: req.timeoutMs,
      signal: req.signal,
    })) {
      if (event.type === 'stdout' || event.type === 'stderr') {
        yield {
          type: event.type,
          data: scrubSecrets(
            event.data,
            lease.secrets.map((secret) => secret.value),
          ),
        };
      } else {
        yield event;
      }
    }
  }

  async heartbeat(runnerId: string): Promise<RunnerHeartbeat> {
    const lease = this.leases.get(runnerId);
    if (!lease) return { runnerId, alive: false, kind: this.kind };

    const alive = this.isAlive(lease);
    return {
      runnerId,
      alive,
      kind: this.kind,
      uptimeMs: alive ? Math.max(0, Date.now() - lease.startedAt) : undefined,
    };
  }

  async artifacts(runnerId: string, req: ArtifactRequest): Promise<Artifact[]> {
    const lease = this.leases.get(runnerId);
    if (!lease) throw new RunnerError('runner_not_found', `no sandbox for ${runnerId}`);

    await mkdir(req.destDir, { recursive: true });
    if (req.paths && req.paths.length > 0) {
      await copyFromWorkspace(lease.workspace, req.paths, req.destDir);
    }
    if (req.includeGitDiff) await writePatch(lease.workspace, req.destDir);

    return hashArtifacts(req.destDir);
  }

  async kill(runnerId: string): Promise<void> {
    const lease = this.leases.get(runnerId);
    if (!lease) return; // idempotent: nothing leased under this id

    await this.terminate(lease.child);
    if (!lease.keepWorkspace) await removeDir(lease.workspace).catch(() => undefined);
    this.leases.delete(runnerId);
  }

  /** Diagnostics: harness stderr captured so far. */
  logs(runnerId: string): string | undefined {
    return this.leases.get(runnerId)?.stderr;
  }

  /* ---------------------------------------------------------------------- */

  private harnessCommand(configured: string, port: number): string {
    if (configured === DEFAULT_HARNESS_COMMAND) {
      // The default command hardcodes the container port; locally we pick a free one.
      return `opencode serve --hostname 127.0.0.1 --port ${port}`;
    }
    return configured;
  }

  private isAlive(lease: LocalLease): boolean {
    const pid = lease.child?.pid;
    if (!pid) return false;
    const code = lease.child?.exitCode;
    if (code !== null && code !== undefined) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  private async terminate(child?: ChildProcess): Promise<void> {
    if (!child?.pid) return;
    try {
      // The harness is spawned detached, so killing the group also stops its children.
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      try {
        child.kill('SIGTERM');
      } catch {
        return;
      }
    }

    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (child.exitCode !== null) return;
      await sleep(100);
    }

    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
