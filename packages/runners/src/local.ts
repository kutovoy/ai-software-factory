import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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
  runCommand,
  sleep,
  streamCommand,
  waitForReady,
  writePatch,
} from './util';

export type LocalShellKind = 'posix' | 'powershell' | 'cmd';

/** The native backend's default shell: PowerShell on Windows, `/bin/sh` elsewhere. */
export function defaultShell(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'powershell.exe' : '/bin/sh';
}

/**
 * Rewrites the default harness command to a host-local port and loopback hostname.
 *
 * The command may carry an env prefix (`OPENAI_BASE_URL='…' OPENAI_API_KEY='…'
 * OPENCODE_SERVER_PASSWORD='…' opencode serve …`) added by the workflow, so equality
 * alone is not enough. The exact default substring is replaced wherever it appears; a
 * custom command with an explicit port is left untouched.
 */
export function localHarnessCommand(configured: string, port: number): string {
  const local = `opencode serve --hostname 127.0.0.1 --port ${port}`;
  if (configured === DEFAULT_HARNESS_COMMAND) return local;
  if (configured.includes(DEFAULT_HARNESS_COMMAND)) {
    return configured.replace(DEFAULT_HARNESS_COMMAND, local);
  }
  return configured;
}

/** Classifies a shell path/name so argv and quoting match the interpreter. */
export function shellKind(shell: string): LocalShellKind {
  const base = (shell.replace(/\\/g, '/').split('/').pop() ?? '').toLowerCase();
  if (base === 'powershell.exe' || base === 'powershell' || base === 'pwsh.exe' || base === 'pwsh') {
    return 'powershell';
  }
  if (base === 'cmd.exe' || base === 'cmd') return 'cmd';
  return 'posix';
}

/**
 * `<shell> -c <command>` on POSIX, `-NoProfile -NonInteractive -Command` for PowerShell
 * and `/d /s /c` for cmd.exe. Windows has no `/bin/sh`, so the flags are shell-specific.
 */
export function shellArgv(shell: string, command: string): string[] {
  const kind = shellKind(shell);
  if (kind === 'powershell') {
    return [shell, '-NoProfile', '-NonInteractive', '-Command', command];
  }
  if (kind === 'cmd') return [shell, '/d', '/s', '/c', command];
  return [shell, '-c', command];
}

/** Single-quotes a PowerShell literal; an embedded `'` doubles (PowerShell escaping). */
export function powershellQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function cmdQuote(value: string): string {
  if (value === '' || /[\s"&|<>^()%!,;=]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

/**
 * Joins an argv array into a single command line for the selected shell.
 *
 * POSIX uses `'…'` with `'\''` escaping (identical to the pre-Windows behaviour). PowerShell
 * needs the call operator (`&`) so a quoted program name is still executed, with single-quoted
 * arguments; cmd.exe uses double quotes.
 */
export function quoteCommandArgs(args: readonly string[], shell: string): string {
  const kind = shellKind(shell);
  if (kind === 'powershell') {
    return args.length === 0 ? '' : `& ${args.map(powershellQuote).join(' ')}`;
  }
  if (kind === 'cmd') return args.map(cmdQuote).join(' ');
  return args.map(posixQuote).join(' ');
}

export interface LocalRunnerOptions {
  allowedSecrets?: readonly string[];
  resolveSecret?: (name: string) => string | undefined | Promise<string | undefined>;
  readyTimeoutMs?: number;
  /** Extra env for the harness process. */
  harnessEnv?: Record<string, string>;
  /** Shell used to run commands. Defaults to `/bin/sh` (POSIX) or `powershell.exe` (win32). */
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
  /** Per-run sandbox directory created by the backend (removed on kill). */
  sandboxRunDir: string | null;
  /** Per-run HOME/XDG dir for macOS sandbox-exec (removed on kill). */
  sandboxHome: string | null;
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
 *
 * On Windows the same backend runs the harness through `powershell.exe` (no `/bin/sh`),
 * quotes array commands PowerShell-style and terminates the process tree with `taskkill`.
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
    this.platform = options.platform ?? process.platform;
    this.shell = options.shell ?? defaultShell(this.platform);
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

    // A remote lease has no central run directory. Give the sandbox its own per-run
    // directory instead of writing `/tmp/.sandbox.sb` or a central `/app/runs/...` path.
    const sandboxRunDir =
      !spec.runDir && availability.active
        ? await mkdtemp(join(tmpdir(), 'factory-sandbox-run-'))
        : null;
    const runDir = spec.runDir ?? sandboxRunDir ?? dirname(workspace);

    // macOS `sandbox-exec` allows writes only to the workspace/run dir/tmp. opencode also
    // needs a writable HOME/XDG tree for its session DB, cache and state; a per-run home
    // keeps that inside the jail without touching the operator's real home.
    const sandboxHome =
      availability.active && this.sandboxMode === 'exec'
        ? await mkdtemp(join(tmpdir(), 'factory-sandbox-home-'))
        : null;
    if (sandboxHome) {
      await Promise.all([
        mkdir(join(sandboxHome, '.config'), { recursive: true }),
        mkdir(join(sandboxHome, '.local', 'share'), { recursive: true }),
        mkdir(join(sandboxHome, '.local', 'state'), { recursive: true }),
        mkdir(join(sandboxHome, '.cache'), { recursive: true }),
      ]);
    }

    const env: Record<string, string> = {
      ...sanitizeHostEnv(process.env),
      ...this.harnessEnv,
      ...spec.harness.env,
      ...spec.env,
      ...(sandboxHome ? sandboxHomeEnv(sandboxHome) : {}),
      PORT: String(port),
    };
    for (const secret of secrets) env[secret.name] = secret.value;

    const command = this.harnessCommand(spec.harness.command, port);
    const network = spec.networkPolicy ?? 'denied';
    let profilePath: string | null = null;
    let argv = shellArgv(this.shell, command);
    if (availability.active && this.sandboxMode === 'exec') {
      await mkdir(runDir, { recursive: true });
      profilePath = join(runDir, '.sandbox.sb');
      await writeFile(
        profilePath,
        buildSandboxProfile({
          workspace,
          runDir,
          network,
          ...(sandboxHome ? { extraWritePaths: [sandboxHome] } : {}),
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
      // POSIX: its own process group so `kill` takes the whole tree. Windows has no
      // process groups; `taskkill /t` walks the tree instead.
      detached: this.platform !== 'win32',
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
      await Promise.all([
        removeDir(workspace).catch(() => undefined),
        ...(sandboxRunDir ? [removeDir(sandboxRunDir).catch(() => undefined)] : []),
        ...(sandboxHome ? [removeDir(sandboxHome).catch(() => undefined)] : []),
      ]);
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
      sandboxRunDir,
      sandboxHome,
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
      ...(lease.sandboxHome ? sandboxHomeEnv(lease.sandboxHome) : {}),
    };
    for (const secret of lease.secrets) env[secret.name] = secret.value;
    Object.assign(env, req.env ?? {});

    const commandString = Array.isArray(req.command)
      ? quoteCommandArgs(req.command, this.shell)
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
      command = shellArgv(this.shell, commandString);
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
    if (lease.sandboxRunDir) await removeDir(lease.sandboxRunDir).catch(() => undefined);
    if (lease.sandboxHome) await removeDir(lease.sandboxHome).catch(() => undefined);
    this.leases.delete(runnerId);
  }

  /** Diagnostics: harness stderr captured so far. */
  logs(runnerId: string): string | undefined {
    return this.leases.get(runnerId)?.stderr;
  }

  /* ---------------------------------------------------------------------- */

  private harnessCommand(configured: string, port: number): string {
    return localHarnessCommand(configured, port);
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

    if (this.platform === 'win32') {
      // Windows has no process groups: `taskkill /t` walks the child tree, `/f` forces it.
      const result = await runCommand(
        ['taskkill', '/pid', String(child.pid), '/t', '/f'],
        { timeoutMs: 10_000 },
      ).catch(() => undefined);
      if (!result || result.code !== 0) {
        // Fall back to the direct child when taskkill is missing or the pid is already gone.
        try {
          child.kill();
        } catch {
          return;
        }
      }
      for (let attempt = 0; attempt < 20; attempt += 1) {
        if (child.exitCode !== null) return;
        await sleep(100);
      }
      return;
    }

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

/** Writable HOME/XDG tree for a macOS `sandbox-exec` lease. */
function sandboxHomeEnv(home: string): Record<string, string> {
  return {
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_STATE_HOME: join(home, '.local', 'state'),
    XDG_CACHE_HOME: join(home, '.cache'),
  };
}

function posixQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
