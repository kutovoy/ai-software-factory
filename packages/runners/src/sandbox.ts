import { accessSync, constants, realpathSync, statSync } from 'node:fs';

/**
 * macOS `sandbox-exec` profile generation (harden-runtime, task 6, ADR-025).
 *
 * The local backend is not a security boundary by default; with `RUNNER_SANDBOX=exec` it
 * runs the harness under a generated SBPL profile:
 *   - deny everything by default;
 *   - allow reads of system paths and the workspace;
 *   - allow writes only to the workspace, the run directory and `/private/tmp`;
 *   - deny `network*` unless the factory grants network to the stage.
 *
 * sandbox-exec is deprecated by Apple but still functional; the flag keeps it opt-in so a
 * replacement does not break runs, and non-macOS hosts fall back to the unsandboxed
 * behaviour with an explicit `runner.sandbox_unavailable` record.
 */

export type SandboxMode = 'exec' | 'none';

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
  /** Stable reason when `mode: exec` could not be honoured. */
  reason: string | null;
  /** True when the reason means the platform has no sandbox backend. */
  unavailable: boolean;
}

export const SANDBOX_EXEC_PATH = '/usr/bin/sandbox-exec';

/** Resolves whether a requested sandbox mode can be honoured on this host. */
export function sandboxAvailability(
  mode: SandboxMode,
  platform: NodeJS.Platform = process.platform,
): SandboxAvailability {
  if (mode === 'none') return { mode, active: false, reason: null, unavailable: false };
  if (platform !== 'darwin') {
    return {
      mode,
      active: false,
      reason: `unsupported_platform: sandbox-exec is macOS-only (platform is ${platform})`,
      unavailable: true,
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
    };
  }
  return { mode, active: true, reason: null, unavailable: false };
}

/** `sandbox-exec -f <profile> <shell> -c <command>` argv. */
export function sandboxCommand(profilePath: string, shell: string, command: string): string[] {
  return [SANDBOX_EXEC_PATH, '-f', profilePath, shell, '-c', command];
}

export function sandboxModeFromEnv(value: string | undefined): SandboxMode {
  return value === 'exec' ? 'exec' : 'none';
}
