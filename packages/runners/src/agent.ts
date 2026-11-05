import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { arch as hostArch, hostname } from 'node:os';
import { dirname } from 'node:path';
import { isAdapterError } from '@factory/adapters';
import { collectMetrics } from './agent-metrics';
import { RunnerAgentRuntime, type AgentRuntimeOptions } from './agent-runtime';
import { RunnerError } from './errors';
import {
  DEFAULT_COMMAND_POLL_TIMEOUT_MS,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  type RunnerCommandEnvelope,
  type RunnerCommandError,
  type RunnerEnrollmentRequest,
  type RunnerEnrollmentResponse,
  type RunnerHostPlatform,
} from './remote-protocol';

/**
 * Remote runner agent.
 *
 * A long-lived process on a Linux (or macOS/Windows) host that enrolls once, then polls
 * the control plane over outbound HTTPS. It is deliberately *not* a Temporal worker and
 * *not* a Postgres client: the central worker enqueues commands, the agent executes them
 * against a local sandbox, and results travel back on the same connection. Nothing here
 * holds a provider credential.
 *
 * Start it with `bun packages/runners/src/agent.ts` (or `node --experimental-strip-types`).
 */

const PLATFORMS: readonly RunnerHostPlatform[] = ['linux', 'windows', 'macos'];
const ENROLL_PATH = '/api/v1/runner-agent/enroll';
const HEARTBEAT_PATH = '/api/v1/runner-agent/heartbeat';
const COMMANDS_PATH = '/api/v1/runner-agent/commands';
const DEFAULT_STATE_FILE = '.runner-agent.json';
const DEFAULT_AGENT_VERSION = '0.0.0';
const REQUEST_TIMEOUT_MS = 30_000;
const POLL_ERROR_BACKOFF_MS = 1_000;

export interface AgentOptions {
  /** Control plane base URL. Defaults to `FACTORY_API_URL`. */
  apiUrl?: string;
  /** One-shot enrollment token. Defaults to `RUNNER_ENROLLMENT_TOKEN`. */
  enrollmentToken?: string;
  /** Stored agent token. Defaults to `RUNNER_AGENT_TOKEN` or the state file. */
  agentToken?: string;
  /** Enrollment state file. Defaults to `RUNNER_STATE_FILE` or `.runner-agent.json`. */
  stateFile?: string;
  name?: string;
  platform?: RunnerHostPlatform;
  arch?: string;
  pool?: string;
  labels?: Record<string, string>;
  maxConcurrent?: number;
  heartbeatIntervalMs?: number;
  commandPollTimeoutMs?: number;
  backend?: 'docker' | 'local';
  agentVersion?: string;
  allowedSecrets?: readonly string[];
  resolveSecret?: (name: string) => string | undefined;
  network?: string;
  workspaceMode?: 'bind' | 'copy';
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Env source. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** External shutdown signal (tests); SIGINT/SIGTERM are handled automatically. */
  signal?: AbortSignal;
}

export interface AgentHandle {
  hostId: string;
  agentToken: string;
  runtime: RunnerAgentRuntime;
  /** Resolves when both loops stop (graceful shutdown). */
  done: Promise<void>;
  /** Aborts the loops and waits for them to finish. Idempotent. */
  stop(): Promise<void>;
}

interface AgentConfig {
  apiUrl: string;
  enrollmentToken?: string;
  agentToken?: string;
  stateFile: string;
  name: string;
  platform: RunnerHostPlatform;
  arch: string;
  pool: string;
  labels: Record<string, string>;
  maxConcurrent: number;
  heartbeatIntervalMs?: number;
  commandPollTimeoutMs?: number;
  backend: 'docker' | 'local';
  agentVersion: string;
  allowedSecrets?: readonly string[];
  resolveSecret?: (name: string) => string | undefined;
  network?: string;
  workspaceMode?: 'bind' | 'copy';
}

interface AgentState {
  hostId?: string;
  agentToken?: string;
}

/** Loads configuration from explicit options first, then the documented env vars. */
export function resolveAgentConfig(
  options: AgentOptions = {},
  env: Record<string, string | undefined> = options.env ?? process.env,
): AgentConfig {
  const apiUrl = trim(options.apiUrl ?? env.FACTORY_API_URL);
  if (!apiUrl) {
    throw new Error('FACTORY_API_URL is required (e.g. https://factory.example.com)');
  }

  const platformRaw = trim(options.platform ?? env.RUNNER_PLATFORM) ?? 'linux';
  const platform = platformRaw.toLowerCase() as RunnerHostPlatform;
  if (!PLATFORMS.includes(platform)) {
    throw new Error(`RUNNER_PLATFORM must be one of ${PLATFORMS.join(', ')} (got "${platformRaw}")`);
  }

  const backendRaw = trim(options.backend ?? env.RUNNER_BACKEND) ?? 'docker';
  if (backendRaw !== 'docker' && backendRaw !== 'local') {
    throw new Error(`RUNNER_BACKEND must be "docker" or "local" (got "${backendRaw}")`);
  }

  return {
    apiUrl,
    ...(trim(options.enrollmentToken ?? env.RUNNER_ENROLLMENT_TOKEN)
      ? { enrollmentToken: trim(options.enrollmentToken ?? env.RUNNER_ENROLLMENT_TOKEN) as string }
      : {}),
    ...(trim(options.agentToken ?? env.RUNNER_AGENT_TOKEN)
      ? { agentToken: trim(options.agentToken ?? env.RUNNER_AGENT_TOKEN) as string }
      : {}),
    stateFile: trim(options.stateFile ?? env.RUNNER_STATE_FILE) ?? DEFAULT_STATE_FILE,
    name: clampText(trim(options.name ?? env.RUNNER_NAME) ?? hostname(), 64),
    platform,
    arch: clampText(trim(options.arch ?? env.RUNNER_ARCH) ?? hostArch(), 32),
    pool: clampText(trim(options.pool ?? env.RUNNER_POOL) ?? 'default', 64),
    labels: clampLabels(options.labels ?? parseLabels(env.RUNNER_LABELS)),
    maxConcurrent: Math.min(
      64,
      positiveInt(options.maxConcurrent ?? env.RUNNER_MAX_CONCURRENT ?? 1, 1, 'RUNNER_MAX_CONCURRENT'),
    ),
    ...(definedInt(options.heartbeatIntervalMs ?? env.RUNNER_HEARTBEAT_INTERVAL_MS)
      ? {
          heartbeatIntervalMs: positiveInt(
            options.heartbeatIntervalMs ?? env.RUNNER_HEARTBEAT_INTERVAL_MS,
            1_000,
            'RUNNER_HEARTBEAT_INTERVAL_MS',
          ),
        }
      : {}),
    ...(definedInt(options.commandPollTimeoutMs ?? env.RUNNER_COMMAND_POLL_TIMEOUT_MS)
      ? {
          commandPollTimeoutMs: positiveInt(
            options.commandPollTimeoutMs ?? env.RUNNER_COMMAND_POLL_TIMEOUT_MS,
            1_000,
            'RUNNER_COMMAND_POLL_TIMEOUT_MS',
          ),
        }
      : {}),
    backend: backendRaw,
    agentVersion: clampText(
      trim(options.agentVersion ?? env.RUNNER_AGENT_VERSION) ?? DEFAULT_AGENT_VERSION,
      64,
    ),
    ...(options.allowedSecrets ? { allowedSecrets: options.allowedSecrets } : {}),
    ...(options.resolveSecret ? { resolveSecret: options.resolveSecret } : {}),
    ...(trim(options.network ?? env.RUNNER_DOCKER_NETWORK)
      ? { network: trim(options.network ?? env.RUNNER_DOCKER_NETWORK) as string }
      : {}),
    ...((options.workspaceMode ?? trim(env.RUNNER_WORKSPACE_MODE)) === 'copy'
      ? { workspaceMode: 'copy' as const }
      : {}),
  };
}

/**
 * Enrolls (if needed), then runs the heartbeat and command loops concurrently until a
 * signal aborts them. Returns a handle once enrollment succeeded.
 */
export async function runAgent(options: AgentOptions = {}): Promise<AgentHandle> {
  const config = resolveAgentConfig(options);
  const fetchImpl = options.fetchImpl ?? fetch;

  const state = await loadState(config.stateFile);
  let hostId = state?.hostId;
  let agentToken = config.agentToken ?? state?.agentToken;
  let enrollment: RunnerEnrollmentResponse | undefined;

  if (!agentToken) {
    if (!config.enrollmentToken) {
      throw new Error(
        'RUNNER_ENROLLMENT_TOKEN is required on first start (or RUNNER_AGENT_TOKEN for an already enrolled host)',
      );
    }
    enrollment = await enroll(config, fetchImpl);
    hostId = enrollment.hostId;
    agentToken = enrollment.agentToken;
    await saveState(config.stateFile, { hostId, agentToken });
    log('enrolled', { hostId, pool: config.pool, platform: config.platform });
  }

  if (!hostId) {
    hostId = '';
    logWarn('missing_host_id', { stateFile: config.stateFile });
  }

  const heartbeatIntervalMs =
    config.heartbeatIntervalMs ??
    enrollment?.heartbeatIntervalMs ??
    DEFAULT_HEARTBEAT_INTERVAL_MS;
  const commandPollTimeoutMs =
    config.commandPollTimeoutMs ??
    enrollment?.commandPollTimeoutMs ??
    DEFAULT_COMMAND_POLL_TIMEOUT_MS;

  const runtimeOptions: AgentRuntimeOptions = {
    agentVersion: config.agentVersion,
    backend: config.backend,
    ...(config.allowedSecrets ? { allowedSecrets: config.allowedSecrets } : {}),
    ...(config.resolveSecret ? { resolveSecret: config.resolveSecret } : {}),
    ...(config.network ? { network: config.network } : {}),
    ...(config.workspaceMode ? { workspaceMode: config.workspaceMode } : {}),
  };
  const runtime = new RunnerAgentRuntime(runtimeOptions);

  const controller = new AbortController();
  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];
  const onSignal = (signal: NodeJS.Signals): void => {
    log('shutdown_requested', { signal });
    controller.abort();
  };
  for (const signal of signals) process.once(signal, onSignal);

  const onExternalAbort = (): void => controller.abort();
  options.signal?.addEventListener('abort', onExternalAbort, { once: true });
  if (options.signal?.aborted) controller.abort();

  const token = agentToken;

  const request = async (
    path: string,
    init: RequestInit,
    timeoutMs: number,
  ): Promise<unknown> => {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    headers.authorization = `Bearer ${token}`;
    const response = await fetchImpl(`${config.apiUrl}${path}`, {
      ...init,
      headers,
      signal: timeoutSignal(timeoutMs, controller.signal),
    });
    return readResponse(response);
  };

  const heartbeatLoop = async (): Promise<void> => {
    while (!controller.signal.aborted) {
      try {
        const leases = runtime.leases();
        const metrics = await collectMetrics(config.agentVersion);
        metrics.leases = leases;
        await request(
          HEARTBEAT_PATH,
          {
            method: 'POST',
            body: JSON.stringify({ metrics, status: 'ready', leases }),
          },
          15_000,
        );
        log('heartbeat', {
          leases,
          cpuPercent: metrics.cpuPercent,
          memoryUsedPercent: metrics.memoryUsedPercent,
          disks: metrics.disks.length,
        });
      } catch (error) {
        if (controller.signal.aborted) break;
        logError('heartbeat_failed', { message: errorMessage(error) });
      }
      await delay(heartbeatIntervalMs, controller.signal);
    }
  };

  const handleCommand = async (command: RunnerCommandEnvelope): Promise<void> => {
    const startedAt = Date.now();
    const resultPath = `${COMMANDS_PATH}/${encodeURIComponent(command.id)}/result`;
    try {
      const result = await runtime.execute(command);
      await request(
        resultPath,
        { method: 'POST', body: JSON.stringify({ commandId: command.id, ok: true, result }) },
        60_000,
      );
      log('command_completed', {
        commandId: command.id,
        type: command.type,
        durationMs: Date.now() - startedAt,
      });
    } catch (error) {
      const shape = toCommandError(error);
      logError('command_failed', {
        commandId: command.id,
        type: command.type,
        code: shape.code,
        message: shape.message,
      });
      try {
        await request(
          resultPath,
          {
            method: 'POST',
            body: JSON.stringify({ commandId: command.id, ok: false, error: shape }),
          },
          60_000,
        );
      } catch (postError) {
        logError('command_result_failed', {
          commandId: command.id,
          message: errorMessage(postError),
        });
      }
    }
  };

  const commandLoop = async (): Promise<void> => {
    while (!controller.signal.aborted) {
      try {
        const response = await request(
          `${COMMANDS_PATH}?waitMs=${commandPollTimeoutMs}`,
          { method: 'GET' },
          commandPollTimeoutMs + 10_000,
        );
        const commands = extractCommands(response);
        for (const command of commands) {
          if (controller.signal.aborted) break;
          await handleCommand(command);
        }
      } catch (error) {
        if (controller.signal.aborted) break;
        logError('command_poll_failed', { message: errorMessage(error) });
        await delay(POLL_ERROR_BACKOFF_MS, controller.signal);
      }
    }
  };

  log('agent_started', {
    apiUrl: config.apiUrl,
    hostId,
    name: config.name,
    platform: config.platform,
    arch: config.arch,
    pool: config.pool,
    backend: config.backend,
    maxConcurrent: config.maxConcurrent,
    heartbeatIntervalMs,
    commandPollTimeoutMs,
    agentVersion: config.agentVersion,
  });

  const done = Promise.all([heartbeatLoop(), commandLoop()]).then(() => {
    log('agent_stopped', { hostId });
  });

  const cleanup = (): void => {
    for (const signal of signals) process.removeListener(signal, onSignal);
    options.signal?.removeEventListener('abort', onExternalAbort);
  };

  return {
    hostId,
    agentToken: token,
    runtime,
    done,
    async stop(): Promise<void> {
      controller.abort();
      await done.catch(() => undefined);
      cleanup();
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Enrollment                                                                 */
/* -------------------------------------------------------------------------- */

async function enroll(
  config: AgentConfig,
  fetchImpl: typeof fetch,
): Promise<RunnerEnrollmentResponse> {
  const body: RunnerEnrollmentRequest = {
    token: config.enrollmentToken as string,
    name: config.name,
    platform: config.platform,
    arch: config.arch,
    pool: config.pool,
    labels: config.labels,
    maxConcurrent: config.maxConcurrent,
    agentVersion: config.agentVersion,
    hostname: clampText(hostname(), 255),
  };

  const response = await fetchImpl(`${config.apiUrl}${ENROLL_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  const parsed = await readResponse(response);
  const record = asRecord(parsed);
  const hostId = typeof record.hostId === 'string' ? record.hostId : '';
  const agentToken = typeof record.agentToken === 'string' ? record.agentToken : '';
  if (hostId === '' || agentToken === '') {
    throw new Error('runner enrollment response is missing hostId/agentToken');
  }

  return {
    hostId,
    agentToken,
    heartbeatIntervalMs:
      typeof record.heartbeatIntervalMs === 'number'
        ? record.heartbeatIntervalMs
        : DEFAULT_HEARTBEAT_INTERVAL_MS,
    commandPollTimeoutMs:
      typeof record.commandPollTimeoutMs === 'number'
        ? record.commandPollTimeoutMs
        : DEFAULT_COMMAND_POLL_TIMEOUT_MS,
  };
}

/* -------------------------------------------------------------------------- */
/* State                                                                      */
/* -------------------------------------------------------------------------- */

async function loadState(file: string): Promise<AgentState | undefined> {
  try {
    const text = await readFile(file, 'utf8');
    const record = asRecord(JSON.parse(text));
    return {
      ...(typeof record.hostId === 'string' ? { hostId: record.hostId } : {}),
      ...(typeof record.agentToken === 'string' ? { agentToken: record.agentToken } : {}),
    };
  } catch {
    return undefined;
  }
}

async function saveState(file: string, state: AgentState): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  // 0600: the agent token is a credential; the file must not be world-readable.
  await writeFile(file, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await chmod(file, 0o600).catch(() => undefined);
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

async function readResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  const body: unknown = text === '' ? undefined : safeJson(text);
  if (!response.ok) {
    const record = asRecord(body);
    const message =
      typeof record.message === 'string'
        ? record.message
        : typeof record.error === 'string'
          ? record.error
          : text.slice(0, 500);
    throw new Error(`HTTP ${response.status} ${response.statusText}: ${message}`);
  }
  return body;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/**
 * Accepts the shapes a control plane may return for a poll: a bare array, `{commands: []}`,
 * `{command: {...}}` or a single envelope. Anything else is treated as "no work".
 */
function extractCommands(value: unknown): RunnerCommandEnvelope[] {
  if (Array.isArray(value)) return value.filter(isCommandEnvelope);
  const record = asRecord(value);
  if (Array.isArray(record.commands)) return record.commands.filter(isCommandEnvelope);
  if (record.command !== undefined) {
    return isCommandEnvelope(record.command) ? [record.command] : [];
  }
  return isCommandEnvelope(value) ? [value] : [];
}

function isCommandEnvelope(value: unknown): value is RunnerCommandEnvelope {
  const record = asRecord(value);
  return typeof record.id === 'string' && record.id !== '' && typeof record.type === 'string';
}

function toCommandError(error: unknown): RunnerCommandError {
  if (error instanceof RunnerError) return error.toJSON();
  if (isAdapterError(error)) return error.toJSON();
  if (error instanceof Error) return { code: 'agent_error', message: error.message };
  return { code: 'agent_error', message: String(error) };
}

function parseLabels(raw: string | undefined): Record<string, string> {
  const labels: Record<string, string> = {};
  if (!raw) return labels;
  // The generated install command passes JSON; hand-written env usually uses `k=v,k2=v2`.
  const trimmedRaw = raw.trim();
  if (trimmedRaw.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmedRaw) as Record<string, unknown>;
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === 'string') labels[key] = value;
      }
      return labels;
    } catch {
      // fall through to the comma parser
    }
  }
  for (const pair of raw.split(',')) {
    const trimmed = pair.trim();
    if (trimmed === '') continue;
    const index = trimmed.indexOf('=');
    if (index <= 0) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim();
    if (key !== '') labels[key] = value;
  }
  return labels;
}

/** The API caps label values at 120 chars; clamp defensively before enrolling. */
function clampLabels(labels: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(labels)) {
    const name = clampText(key, 64);
    if (name === '') continue;
    result[name] = clampText(value, 120);
  }
  return result;
}

function clampText(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

function trim(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function definedInt(value: number | string | undefined): boolean {
  return value !== undefined && value !== '';
}

function positiveInt(value: number | string | undefined, min: number, label: string): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed < min) {
    throw new Error(`${label} must be an integer >= ${min} (got "${String(value)}")`);
  }
  return Math.trunc(parsed);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

/** Timeout signal combined with the shutdown signal, without leaking timers. */
function timeoutSignal(ms: number, outer?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  if (!outer) return timeout;
  const any = (AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal }).any;
  return typeof any === 'function' ? any([outer, timeout]) : outer;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function log(event: string, fields: Record<string, unknown>): void {
  process.stdout.write(
    `${JSON.stringify({ level: 'info', event, ts: new Date().toISOString(), ...fields })}\n`,
  );
}

function logWarn(event: string, fields: Record<string, unknown>): void {
  process.stderr.write(
    `${JSON.stringify({ level: 'warn', event, ts: new Date().toISOString(), ...fields })}\n`,
  );
}

function logError(event: string, fields: Record<string, unknown>): void {
  process.stderr.write(
    `${JSON.stringify({ level: 'error', event, ts: new Date().toISOString(), ...fields })}\n`,
  );
}

if (typeof Bun !== 'undefined' && Bun.main === import.meta.path) {
  runAgent()
    .then((handle) => handle.done)
    .catch((error: unknown) => {
      logError('agent_crashed', { message: errorMessage(error) });
      process.exit(1);
    });
}
