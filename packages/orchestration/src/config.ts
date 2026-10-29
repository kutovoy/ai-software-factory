import { join, resolve } from 'node:path';

/**
 * Runtime configuration, resolved once per process from the environment.
 * `TEMPORAL_ADDRESS` is required (ADR-001: Temporal from day one).
 */
export interface OrchestrationConfig {
  temporalAddress: string;
  temporalNamespace: string;
  taskQueue: string;
  databaseUrl: string;
  /** Directory that holds `factories/<name>` definitions (git-backed, ADR-003). */
  factoryRoot: string;
  /** Directory that holds `runs/<runId>/{events.jsonl,patch.diff,artifacts/}`. */
  runsDir: string;
  /** Public base URL of the API's inference proxy, as seen from the sandbox. */
  proxyPublicUrl: string;
  /** Upstream OpenAI-compatible base URL (never exposed to the sandbox). */
  providerBaseUrl?: string;
  providerKey?: string;
  /** Default runner backend when the definition does not name one. */
  defaultRunner: 'docker' | 'local';
  /** How long a `permission.requested` may block before it is auto-denied. */
  permissionTimeoutMs: number;
}

function intFromEnv(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): OrchestrationConfig {
  const factoryRoot = resolve(env.FACTORY_ROOT ?? join(process.cwd(), 'factories'));
  return {
    temporalAddress: env.TEMPORAL_ADDRESS ?? 'localhost:7233',
    temporalNamespace: env.TEMPORAL_NAMESPACE ?? 'default',
    taskQueue: env.TEMPORAL_TASK_QUEUE ?? 'factory-runs',
    databaseUrl: env.DATABASE_URL ?? 'postgres://factory:factory@localhost:5432/factory',
    factoryRoot,
    runsDir: resolve(env.RUNS_DIR ?? join(process.cwd(), 'runs')),
    proxyPublicUrl: env.PROXY_PUBLIC_URL ?? 'http://host.docker.internal:8080/v1',
    providerBaseUrl: env.OPENAI_BASE_URL,
    providerKey: env.OPENAI_API_KEY,
    defaultRunner: env.RUNNER_BACKEND === 'local' ? 'local' : 'docker',
    permissionTimeoutMs: intFromEnv(env.PERMISSION_TIMEOUT_MS, 30 * 60 * 1000),
  };
}
