import { runCommand } from '@factory/runners';
import { DEFAULT_EXECUTION_ALLOWLIST, isInferenceCredential, scrubSecrets } from '@factory/runners';

/**
 * Transport-level MCP probe (spec `mcp-integration` › connection test, ADR-010).
 *
 * Runs on the runner/worker host, never in the API process. Two transports:
 *   - stdio: spawn the command and treat "exited 0" or "still alive at the timeout" as
 *     reachable (a server that stays up has started; it is killed after the probe);
 *   - http: one request to the endpoint, any non-5xx answer counts as reachable.
 *
 * Credentials are resolved here, in the runner, from the environment by name and are
 * scrubbed from any recorded error (ADR-026). The result carries names, latency and an
 * error string — never a value.
 */

export interface McpProbeServer {
  name: string;
  transport: 'stdio' | 'http';
  command?: string;
  args?: string[];
  /** Environment key -> secret name. */
  env?: Record<string, string>;
  url?: string;
  /** Header name -> secret name. */
  headers?: Record<string, string>;
}

export interface McpProbeResult {
  ok: boolean;
  transport: 'stdio' | 'http';
  latencyMs: number;
  error: string | null;
  /** Where the probe ran; always the runner/worker, never the API (ADR-010). */
  executor: string;
  /** Secret names that could not be resolved (names only). */
  missingSecrets: string[];
}

export interface McpProbeOptions {
  timeoutMs?: number;
  /** Injectable exec for tests (fake transport). Defaults to the runners' `runCommand`. */
  exec?: (
    command: string[],
    options: { env?: Record<string, string>; timeoutMs?: number },
  ) => Promise<{ code: number; stdout: string; stderr: string }>;
  fetchImpl?: typeof fetch;
  /** Secret resolver. Defaults to the process environment; values never leave this scope. */
  resolveSecret?: (name: string) => string | undefined;
  /** Execution allowlist (the runner boundary). Defaults to the runners' allowlist. */
  allowedSecrets?: readonly string[];
}

const DEFAULT_PROBE_TIMEOUT_MS = 5_000;

function envValue(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env[name] ?? env[name.toUpperCase()] ?? env[`SECRET_${name.toUpperCase()}`];
}

interface ResolvedEnv {
  env: Record<string, string>;
  missing: string[];
  values: string[];
}

/** Resolves `key -> secret name` into `key -> value`, refusing inference credentials. */
function resolveEnv(
  mapping: Record<string, string>,
  options: McpProbeOptions,
): ResolvedEnv {
  const resolve = options.resolveSecret ?? ((name: string) => envValue(name));
  const allowed = options.allowedSecrets ?? DEFAULT_EXECUTION_ALLOWLIST;
  const env: Record<string, string> = {};
  const missing: string[] = [];
  const values: string[] = [];

  for (const [key, secretName] of Object.entries(mapping)) {
    if (isInferenceCredential(secretName) || !allowed.includes(secretName)) {
      missing.push(secretName);
      continue;
    }
    const value = resolve(secretName);
    if (value === undefined || value === '') {
      missing.push(secretName);
      continue;
    }
    env[key] = value;
    values.push(value);
  }

  return { env, missing, values };
}

export async function probeMcpServer(
  server: McpProbeServer,
  options: McpProbeOptions = {},
): Promise<McpProbeResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const startedAt = Date.now();

  if (server.transport === 'stdio') {
    return probeStdio(server, options, timeoutMs, startedAt);
  }
  return probeHttp(server, options, timeoutMs, startedAt);
}

async function probeStdio(
  server: McpProbeServer,
  options: McpProbeOptions,
  timeoutMs: number,
  startedAt: number,
): Promise<McpProbeResult> {
  if (!server.command) {
    return {
      ok: false,
      transport: 'stdio',
      latencyMs: Date.now() - startedAt,
      error: 'stdio server has no command',
      executor: 'worker',
      missingSecrets: [],
    };
  }

  const resolved = resolveEnv(server.env ?? {}, options);
  if (resolved.missing.length > 0) {
    return {
      ok: false,
      transport: 'stdio',
      latencyMs: Date.now() - startedAt,
      error: `secret not resolvable in the runner: ${resolved.missing.join(', ')}`,
      executor: 'worker',
      missingSecrets: resolved.missing,
    };
  }

  const command = [server.command, ...(server.args ?? [])];
  const exec = options.exec ?? ((argv, execOptions) => runCommand(argv, execOptions));

  try {
    const result = await exec(command, { env: resolved.env, timeoutMs });
    const latencyMs = Date.now() - startedAt;
    // 124 = killed at the timeout: a stdio MCP server is a long-lived process, so
    // "still running" is the healthy case; a non-zero early exit is the failure.
    const ok = result.code === 0 || result.code === 124;
    const error = ok ? null : scrubSecrets((result.stderr || result.stdout).trim(), resolved.values);
    return {
      ok,
      transport: 'stdio',
      latencyMs,
      error: error && error.length > 0 ? error.slice(0, 2000) : ok ? null : `exit ${result.code}`,
      executor: 'worker',
      missingSecrets: [],
    };
  } catch (error) {
    return {
      ok: false,
      transport: 'stdio',
      latencyMs: Date.now() - startedAt,
      error: scrubSecrets(error instanceof Error ? error.message : String(error), resolved.values),
      executor: 'worker',
      missingSecrets: [],
    };
  }
}

async function probeHttp(
  server: McpProbeServer,
  options: McpProbeOptions,
  timeoutMs: number,
  startedAt: number,
): Promise<McpProbeResult> {
  if (!server.url) {
    return {
      ok: false,
      transport: 'http',
      latencyMs: Date.now() - startedAt,
      error: 'http server has no url',
      executor: 'worker',
      missingSecrets: [],
    };
  }

  const resolved = resolveEnv(server.headers ?? {}, options);
  if (resolved.missing.length > 0) {
    return {
      ok: false,
      transport: 'http',
      latencyMs: Date.now() - startedAt,
      error: `secret not resolvable in the runner: ${resolved.missing.join(', ')}`,
      executor: 'worker',
      missingSecrets: resolved.missing,
    };
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(server.url, {
      method: 'GET',
      headers: { accept: 'application/json', ...resolved.env },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const latencyMs = Date.now() - startedAt;
    // A 401/404 still proves the endpoint answers; only a 5xx or a transport error fails.
    const ok = response.status < 500;
    return {
      ok,
      transport: 'http',
      latencyMs,
      error: ok ? null : `HTTP ${response.status}`,
      executor: 'worker',
      missingSecrets: [],
    };
  } catch (error) {
    return {
      ok: false,
      transport: 'http',
      latencyMs: Date.now() - startedAt,
      error: scrubSecrets(error instanceof Error ? error.message : String(error), resolved.values),
      executor: 'worker',
      missingSecrets: [],
    };
  }
}
