import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { RunnerError } from './errors';
import {
  buildSandboxProfile,
  bwrapCommand,
  sandboxAvailability,
  sandboxCommand,
  sandboxModeFromEnv,
  type SandboxLookupOptions,
  type SandboxMode,
} from './sandbox';
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
  /**
   * `exec` confines the harness with macOS sandbox-exec, `bwrap` with a Linux bubblewrap
   * jail; defaults to `RUNNER_SANDBOX` (Linux auto-selects bwrap when installed).
   */
  sandbox?: SandboxMode;
  /** Test hook: pretend to run on another platform (fallback path). */
  platform?: NodeJS.Platform;
  /** Test hook: resolve a sandbox binary (`which`) instead of probing the host. */
  which?: SandboxLookupOptions['which'];
}

interface LocalLease {
  handle: RunnerHandle;
  workspace: string;
  keepWorkspace: boolean;
  secrets: ResolvedSecret[];
  child?: ChildProcess;
  startedAt: number;
  stderr: string;
  profilePath: string | null;
  /** Network policy the jail was built with (`--unshare-net` when denied). */
  sandboxNetwork: 'allowed' | 'denied';
  /** Resolved bubblewrap binary when the jail is active. */
  bwrapBinary: string | null;
  sandbox: { mode: SandboxMode; active: boolean; reason: string | null };
}

/**
 * Process-based fallback: same protocol as the docker backend, no Docker.
 *
 * Used for fast tests and dev machines without Docker. Inference credentials are stripped
 * from the inherited environment and only allowlisted execution secrets are injected.
 *
 * With `RUNNER_SANDBOX=exec` (ADR-025) the harness runs under a generated macOS
 * `sandbox-exec` profile: deny by default, read system + workspace, write only the
 * workspace, the run directory and `/private/tmp`, and no network unless the stage grants
 * it. `RUNNER_SANDBOX=bwrap` (harden-runners task 1) runs it in a Linux bubblewrap jail
 * instead — read-only root, writable workspace, `--unshare-net` when network is denied.
 * Linux auto-selects bwrap when the binary is installed. Any other platform falls back to
 * the unsandboxed process and records `runner.sandbox_unavailable` on the lease step; a
 * *requested* bwrap that is missing fails the lease instead of degrading.
 */
export class LocalRunnerBackend implements RunnerBackend {
  readonly kind = 'local' as const;

  private readonly allowedSecrets: readonly string[] | undefined;
  private readonly resolveSecret: LocalRunnerOptions['resolveSecret'];
  private readonly readyTimeoutMs: number;
  private readonly harnessEnv: Record<string, string>;
  private readonly shell: string;
  private readonly sandboxMode: SandboxMode;
  private readonly platform: NodeJS.Platform;
  private readonly which: SandboxLookupOptions['which'];
  private readonly leases = new Map<string, LocalLease>();

  constructor(options: LocalRunnerOptions = {}) {
    this.allowedSecrets = options.allowedSecrets;
    this.resolveSecret = options.resolveSecret;
    this.readyTimeoutMs = options.readyTimeoutMs ?? 30_000;
    this.harnessEnv = options.harnessEnv ?? {};
    this.shell = options.shell ?? '/bin/sh';
    this.platform = options.platform ?? process.platform;
    this.which = options.which;
    this.sandboxMode =
      options.sandbox ??
      sandboxModeFromEnv(process.env.RUNNER_SANDBOX, this.platform, {
        ...(this.which ? { which: this.which } : {}),
      });
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

    // Resolve the sandbox before touching the workspace: a requested `bwrap` that is not
    // installed must fail the lease (`runner.sandbox_unavailable`), never fall back to an
    // unsandboxed process (spec `runner-sandbox` › "Missing bwrap").
    const availability = sandboxAvailability(this.sandboxMode, this.platform, {
      ...(this.which ? { which: this.which } : {}),
    });
    if (this.sandboxMode === 'bwrap' && availability.unavailable) {
      throw new RunnerError(
        'runner.sandbox_unavailable',
        `bwrap sandbox requested but unavailable: ${availability.reason ?? 'unknown reason'}`,
        { runnerId: spec.runnerId, mode: this.sandboxMode, platform: this.platform, reason: availability.reason },
      );
    }

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
    const runDir = spec.runDir ?? dirname(workspace);
    const network = spec.networkPolicy ?? 'denied';
    let profilePath: string | null = null;
    let argv = [this.shell, '-c', command];
    if (availability.active && this.sandboxMode === 'exec') {
      await mkdir(runDir, { recursive: true });
      profilePath = join(runDir, '.sandbox.sb');
      await writeFile(
        profilePath,
        buildSandboxProfile({
          workspace,
          runDir,
          network,
        }),
        'utf8',
      );
      argv = sandboxCommand(profilePath, this.shell, command);
    } else if (availability.active && this.sandboxMode === 'bwrap') {
      // NOTE: `--unshare-net` puts the jail in a private network namespace, so a harness
      // started there cannot be reached from the host's loopback. A bwrap lease therefore
      // needs the stage to grant `networkPolicy: allowed`; with `denied` the lease fails
      // `runner_unavailable` at the readiness probe (the jail itself is still correct).
      argv = bwrapCommand(
        { workspace, network, binary: availability.binary },
        this.shell,
        command,
      );
    }

    const child = spawn(argv[0] as string, argv.slice(1), {
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

    const sandbox = {
      mode: this.sandboxMode,
      active: availability.active,
      reason: availability.reason,
    };
    const handle: RunnerHandle = {
      runnerId: spec.runnerId,
      kind: this.kind,
      workspace,
      harnessUrl: `http://127.0.0.1:${port}`,
      port,
      pid: child.pid,
      sandbox,
    };

    try {
      await waitForReady({
        url: handle.harnessUrl,
        readyPath: spec.harness.readyPath,
        timeoutMs: spec.readyTimeoutMs || this.readyTimeoutMs,
        ...(spec.harness.headers ? { headers: spec.harness.headers } : {}),
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
      profilePath,
      sandboxNetwork: network,
      bwrapBinary: availability.binary,
      sandbox,
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

    const commandString = Array.isArray(req.command)
      ? req.command.map(shellQuote).join(' ')
      : req.command;
    const cwd = req.cwd ?? lease.workspace;
    let command: string[];
    if (lease.sandbox.active && lease.sandbox.mode === 'bwrap') {
      command = bwrapCommand(
        {
          workspace: lease.workspace,
          network: lease.sandboxNetwork,
          cwd,
          binary: lease.bwrapBinary,
        },
        this.shell,
        commandString,
      );
    } else if (lease.sandbox.active && lease.profilePath) {
      command = sandboxCommand(lease.profilePath, this.shell, commandString);
    } else {
      command = [this.shell, '-c', commandString];
    }

    for await (const event of streamCommand(command, {
      cwd,
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
