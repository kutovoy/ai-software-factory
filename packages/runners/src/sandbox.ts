import { spawnSync } from 'node:child_process';
import { accessSync, constants, realpathSync, statSync } from 'node:fs';

/**
 * Sandbox profiles for the local backend (harden-runtime task 6 + harden-runners task 1).
 *
 * The local backend is not a security boundary by default. Two profiles exist:
 *
 *   - `exec` (macOS): a generated SBPL profile run through `sandbox-exec`:
 *       deny everything by default, read system paths + workspace, write only the
 *       workspace, the run directory and `/private/tmp`, deny `network*` unless the
 *       factory grants network to the stage.
 *   - `bwrap` (Linux): a minimal bubblewrap jail:
 *       `--ro-bind / /`, `--dev /dev`, `--proc /proc`, `--tmpfs /tmp`, a writable bind of
 *       the workspace, `--chdir` into it, and `--unshare-net` when the policy denies network.
 *
 * Both are opt-in; `RUNNER_SANDBOX=bwrap|exec|none`. On Linux an unset value auto-selects
 * `bwrap` when the binary is installed. A *requested* profile that cannot be honoured is
 * reported as unavailable — `exec` degrades with an explicit `runner.sandbox_unavailable`
 * record (ADR-025), while a requested `bwrap` fails the run instead of silently running
 * unsandboxed (spec `runner-sandbox` › "Missing bwrap").
 */

export type SandboxMode = 'exec' | 'bwrap' | 'none';

export interface SandboxProfileOptions {
  workspace: string;
  runDir: string;
  network: 'allowed' | 'denied';
  /** Extra writable paths (tests/dev only; the spec allows workspace/tmp/run dir). */
  extraWritePaths?: string[];
}

/** SBPL string literal: escape backslashes and double quotes. */
function sbplString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

export function buildSandboxProfile(options: SandboxProfileOptions): string {
  // macOS `/var` is a symlink to `/private/var`; SBPL matches the canonical path.
  const writable = [
    canonical(options.workspace),
    canonical(options.runDir),
    '/private/tmp',
    ...(options.extraWritePaths ?? []).map(canonical),
  ];
  const writeRules = writable.map((path) => `(subpath ${sbplString(path)})`).join(' ');
  return [
    '(version 1)',
    '(deny default)',
    '(allow process*)',
    '(allow signal)',
    '(allow sysctl-read)',
    '(allow mach-lookup)',
    '(allow file-read*)',
    `(allow file-write* ${writeRules} (literal "/dev/null") (literal "/dev/urandom") (literal "/dev/random") (literal "/dev/stdout") (literal "/dev/stderr"))`,
    // The harness must listen on loopback so the adapter can talk to it; only *outbound*
    // network is the boundary, and that is denied unless the stage grants it.
    '(allow network-bind (local ip "localhost:*"))',
    '(allow network-inbound (local ip "localhost:*"))',
    options.network === 'allowed' ? '(allow network-outbound)' : '(deny network-outbound)',
    '',
  ].join('\n');
}

export interface SandboxAvailability {
  mode: SandboxMode;
  /** True when the harness will actually be confined. */
  active: boolean;
  /** Stable reason when the requested profile could not be honoured. */
  reason: string | null;
  /** True when the reason means the host has no usable backend for this profile. */
  unavailable: boolean;
  /** Absolute path of the sandbox binary when `active`. */
  binary: string | null;
}

export const SANDBOX_EXEC_PATH = '/usr/bin/sandbox-exec';

/** Test hook: resolves an executable name to an absolute path (or `null`). */
export type WhichExecutable = (name: string) => string | null;

export interface SandboxLookupOptions {
  which?: WhichExecutable;
}

/** `which <name>` — the same lookup an operator does on the worker host. */
export function whichExecutable(name: string): string | null {
  const result = spawnSync('which', [name], { encoding: 'utf8' });
  if (result.error || result.status !== 0) return null;
  const found = (result.stdout ?? '').trim();
  return found === '' ? null : found;
}

/** Resolves the bubblewrap binary, or `null` when it is not installed. */
export function bwrapBinary(options: SandboxLookupOptions = {}): string | null {
  const which = options.which ?? whichExecutable;
  return which('bwrap');
}

/** Resolves whether a requested sandbox mode can be honoured on this host. */
export function sandboxAvailability(
  mode: SandboxMode,
  platform: NodeJS.Platform = process.platform,
  options: SandboxLookupOptions = {},
): SandboxAvailability {
  if (mode === 'none') {
    return { mode, active: false, reason: null, unavailable: false, binary: null };
  }

  if (mode === 'bwrap') {
    if (platform !== 'linux') {
      return {
        mode,
        active: false,
        reason: `unsupported_platform: bwrap is Linux-only (platform is ${platform})`,
        unavailable: true,
        binary: null,
      };
    }
    const binary = bwrapBinary(options);
    if (!binary) {
      return {
        mode,
        active: false,
        reason: 'bwrap_missing: `which bwrap` found no executable',
        unavailable: true,
        binary: null,
      };
    }
    return { mode, active: true, reason: null, unavailable: false, binary };
  }

  // `exec`: macOS sandbox-exec.
  if (platform !== 'darwin') {
    return {
      mode,
      active: false,
      reason: `unsupported_platform: sandbox-exec is macOS-only (platform is ${platform})`,
      unavailable: true,
      binary: null,
    };
  }
  try {
    accessSync(SANDBOX_EXEC_PATH, constants.X_OK);
    if (!statSync(SANDBOX_EXEC_PATH).isFile()) throw new Error('not a file');
  } catch {
    return {
      mode,
      active: false,
      reason: `sandbox_exec_missing: ${SANDBOX_EXEC_PATH} is not executable`,
      unavailable: true,
      binary: null,
    };
  }
  return { mode, active: true, reason: null, unavailable: false, binary: SANDBOX_EXEC_PATH };
}

/** `sandbox-exec -f <profile> <shell> -c <command>` argv. */
export function sandboxCommand(profilePath: string, shell: string, command: string): string[] {
  return [SANDBOX_EXEC_PATH, '-f', profilePath, shell, '-c', command];
}

export interface BwrapCommandOptions {
  /** Host directory that stays writable inside the jail (and the default cwd). */
  workspace: string;
  /** Network policy: `denied` unshares the network namespace. */
  network: 'allowed' | 'denied';
  /** Working directory inside the jail; defaults to the workspace. */
  cwd?: string;
  /** Resolved bubblewrap path; defaults to `which bwrap`, then the bare name. */
  binary?: string | null;
}

/**
 * `bwrap --ro-bind / / --dev /dev --proc /proc --tmpfs /tmp --bind <workspace> <workspace>
 * --chdir <workspace> [--unshare-net] -- <shell> -c <command>`
 *
 * Read-only root plus a writable workspace is the whole jail: nothing outside the workspace
 * can be modified, `/tmp` is a private tmpfs, and `--unshare-net` removes every interface but
 * loopback when the stage denies network.
 */
export function bwrapCommand(
  options: BwrapCommandOptions,
  shell: string,
  command: string,
): string[] {
  const binary = options.binary ?? bwrapBinary() ?? 'bwrap';
  const cwd = options.cwd ?? options.workspace;
  const argv = [
    binary,
    '--ro-bind',
    '/',
    '/',
    '--dev',
    '/dev',
    '--proc',
    '/proc',
    '--tmpfs',
    '/tmp',
    '--bind',
    options.workspace,
    options.workspace,
    '--chdir',
    cwd,
  ];
  if (options.network === 'denied') argv.push('--unshare-net');
  argv.push('--', shell, '-c', command);
  return argv;
}

/**
 * `RUNNER_SANDBOX=bwrap|exec|none`. Unset (or an unknown value) means `none`, except on
 * Linux where an installed bubblewrap is selected automatically.
 */
export function sandboxModeFromEnv(
  value: string | undefined,
  platform: NodeJS.Platform = process.platform,
  options: SandboxLookupOptions = {},
): SandboxMode {
  if (value === 'exec' || value === 'bwrap' || value === 'none') return value;
  if (platform === 'linux' && bwrapBinary(options)) return 'bwrap';
  return 'none';
}
