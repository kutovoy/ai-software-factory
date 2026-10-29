import { RunnerError } from './errors';

export type RunnerKind = 'docker' | 'local';

/** Where the workspace comes from. Exactly one of `path` / `url`. */
export interface RepoSpec {
  /** Local git repository to clone from (dev + tests). */
  path?: string;
  /** Remote git URL to clone from. */
  url?: string;
  /** Full SHA (or ref) to pin. Defaults to the source repo's HEAD. */
  commit?: string;
}

export interface HarnessSpec {
  /** Command executed inside the sandbox. Defaults to `opencode serve`. */
  command?: string;
  /** Port the harness listens on inside the sandbox. Defaults to 4096. */
  port?: number;
  /** HTTP path polled for readiness. Defaults to `/api/info` (opencode). */
  readyPath?: string;
  /** Extra env for the harness process only. */
  env?: Record<string, string>;
}

/** Secrets are referenced by name and resolved outside the sandbox. */
export interface SecretRef {
  name: string;
}

export interface RunnerSpec {
  runId: string;
  /**
   * Stable runner identity. Defaults to `factory-<runId>` (sanitised), which makes
   * `lease` idempotent: leasing twice with the same runnerId returns the same sandbox.
   */
  runnerId?: string;
  repo?: RepoSpec;
  /** Host directory to use as the workspace. A temp dir is created when omitted. */
  workspace?: string;
  /** Container image (docker backend only). */
  image?: string;
  harness?: HarnessSpec;
  /** Env for the sandbox (harness + exec). Inference credentials are rejected. */
  env?: Record<string, string>;
  /** Execution secrets to inject. Allowlisted names only. */
  secrets?: SecretRef[];
  cpu?: number;
  memoryMb?: number;
  /** Keep the workspace after `kill` (run directories are always retained). */
  keepWorkspace?: boolean;
  /** Readiness timeout in ms. Defaults to 60_000. */
  readyTimeoutMs?: number;
}

export interface RunnerHandle {
  runnerId: string;
  kind: RunnerKind;
  /** Workspace path as seen by the host (the sandbox mounts it). */
  workspace: string;
  /** Base URL of the harness, reachable from the host. */
  harnessUrl: string;
  containerId?: string;
  containerName?: string;
  port?: number;
  pid?: number;
}

export interface ExecRequest {
  /** A shell command string (`sh -c`) or an argv array. */
  command: string | string[];
  /** Working directory inside the sandbox. Defaults to the workspace. */
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export type ExecEvent =
  | { type: 'stdout'; data: string }
  | { type: 'stderr'; data: string }
  | { type: 'exit'; code: number }
  | { type: 'error'; code: string; message: string };

export interface RunnerHeartbeat {
  runnerId: string;
  alive: boolean;
  kind: RunnerKind;
  uptimeMs?: number;
  cpuPercent?: number;
  memory?: string;
}

export interface ArtifactRequest {
  /** Host directory that receives the artifacts (the run directory). */
  destDir: string;
  /** Paths relative to the workspace to collect. */
  paths?: string[];
  /** Also capture `git diff` of the workspace as `patch.diff`. */
  includeGitDiff?: boolean;
}

export interface Artifact {
  /** Path relative to the run directory. */
  path: string;
  bytes: number;
  sha256: string;
  kind: 'patch' | 'log' | 'screenshot' | 'file';
}

/**
 * Transport-agnostic runner protocol. Every call is idempotent and keyed by `runnerId`,
 * so activities can retry safely (Temporal at-least-once).
 */
export interface RunnerBackend {
  readonly kind: RunnerKind;

  lease(spec: RunnerSpec): Promise<RunnerHandle>;
  exec(runnerId: string, req: ExecRequest): AsyncIterable<ExecEvent>;
  heartbeat(runnerId: string): Promise<RunnerHeartbeat>;
  artifacts(runnerId: string, req: ArtifactRequest): Promise<Artifact[]>;
  kill(runnerId: string): Promise<void>;
}

export const DEFAULT_HARNESS_COMMAND = 'opencode serve --hostname 0.0.0.0 --port 4096';
export const DEFAULT_HARNESS_PORT = 4096;
export const DEFAULT_READY_PATH = '/api/info';
export const DEFAULT_READY_TIMEOUT_MS = 60_000;

export interface NormalizedRunnerSpec extends RunnerSpec {
  runnerId: string;
  harness: Required<Pick<HarnessSpec, 'command' | 'port' | 'readyPath'>> & HarnessSpec;
  readyTimeoutMs: number;
  secrets: SecretRef[];
}

/** Validates and fills defaults. Throws `invalid_spec` with a precise message. */
export function normalizeRunnerSpec(spec: RunnerSpec): NormalizedRunnerSpec {
  if (!spec || typeof spec !== 'object') {
    throw new RunnerError('invalid_spec', 'runner spec is required');
  }
  if (typeof spec.runId !== 'string' || spec.runId.trim() === '') {
    throw new RunnerError('invalid_spec', 'runId is required');
  }

  if (spec.repo?.path && spec.repo?.url) {
    throw new RunnerError('invalid_spec', 'repo must have exactly one of path or url', {
      runId: spec.runId,
    });
  }

  const harness = spec.harness ?? {};
  const port = harness.port ?? DEFAULT_HARNESS_PORT;
  // `0` means "pick a free port" (local backend); docker requires an explicit port.
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new RunnerError('invalid_spec', `invalid harness port ${port}`, { port });
  }

  if (spec.cpu !== undefined && (!(spec.cpu > 0) || spec.cpu > 64)) {
    throw new RunnerError('invalid_spec', `invalid cpu limit ${spec.cpu}`);
  }
  if (spec.memoryMb !== undefined && (!Number.isInteger(spec.memoryMb) || spec.memoryMb < 64)) {
    throw new RunnerError('invalid_spec', `invalid memory limit ${spec.memoryMb}`);
  }

  const runnerId = sanitizeRunnerId(spec.runnerId ?? `factory-${spec.runId}`);

  return {
    ...spec,
    runnerId,
    harness: {
      ...harness,
      command: harness.command ?? DEFAULT_HARNESS_COMMAND,
      port,
      readyPath: harness.readyPath ?? DEFAULT_READY_PATH,
    },
    readyTimeoutMs: spec.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
    secrets: spec.secrets ?? [],
  };
}

export function sanitizeRunnerId(value: string): string {
  const sanitized = value
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
  if (sanitized === '') {
    throw new RunnerError('invalid_spec', `runnerId "${value}" has no usable characters`);
  }
  return sanitized;
}
