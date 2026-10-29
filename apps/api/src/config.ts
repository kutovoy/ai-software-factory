import { join, resolve } from 'node:path';
import type { OrchestrationConfig } from '@factory/orchestration';

/**
 * API configuration. Everything is env-driven so the same image runs in compose, CI and
 * on a laptop (ADR-001/ADR-011). Inference credentials live here and only here.
 */
export interface ApiConfig {
  host: string;
  port: number;
  version: string;
  databaseUrl: string;
  temporalAddress: string;
  factoryRoot: string;
  runsDir: string;
  /** Git root that contains `factoryRoot`; runners clone this at `definitionCommit`. */
  repoRoot: string;
  /** Base URL the sandbox should use to reach this API's `/v1/*` proxy. */
  proxyPublicUrl: string;
  /** Upstream OpenAI-compatible endpoint; never sent to a runner. */
  providerBaseUrl?: string;
  providerKey?: string;
  /** Default factory for `POST /chat`. */
  defaultFactory: string;
  /**
   * Dev/smoke only: return the run's proxy token in the run-creation response so the
   * smoke test can exercise the proxy end to end. Default off.
   */
  exposeRunToken: boolean;
  /** Dev/smoke only: serve a canned model upstream under `/internal/stub-model/v1`. */
  stubUpstream: boolean;
  /** Max wall-clock for the SSE poll loop (ms) before the stream closes. */
  sseMaxLifetimeMs: number;
  /** SLA for a run's human permission wait before it is auto-denied (ADR-013). */
  permissionTimeoutMs: number;
}

function boolFromEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  return value === '1' || value.toLowerCase() === 'true';
}

function intFromEnv(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

export function loadApiConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const factoryRoot = resolve(env.FACTORY_ROOT ?? 'factories');
  return {
    host: env.API_HOST ?? '0.0.0.0',
    port: intFromEnv(env.API_PORT ?? env.PORT, 8080),
    version: env.FACTORY_VERSION ?? '0.0.0-dev',
    databaseUrl: env.DATABASE_URL ?? 'postgres://factory:factory@localhost:5432/factory',
    temporalAddress: env.TEMPORAL_ADDRESS ?? 'localhost:7233',
    factoryRoot,
    repoRoot: resolve(env.REPO_ROOT ?? join(factoryRoot, '..')),
    runsDir: resolve(env.RUNS_DIR ?? 'runs'),
    proxyPublicUrl: env.PROXY_PUBLIC_URL ?? 'http://host.docker.internal:8080/v1',
    providerBaseUrl: env.OPENAI_BASE_URL,
    providerKey: env.OPENAI_API_KEY,
    defaultFactory: env.DEFAULT_FACTORY ?? 'example',
    exposeRunToken: boolFromEnv(env.EXPOSE_RUN_TOKEN, false),
    stubUpstream: boolFromEnv(env.PROXY_STUB_UPSTREAM, false),
    sseMaxLifetimeMs: intFromEnv(env.SSE_MAX_LIFETIME_MS, 30 * 60 * 1000),
    permissionTimeoutMs: intFromEnv(env.PERMISSION_TIMEOUT_MS, 30 * 60 * 1000),
  };
}

/** Applies the API config to the orchestration config (single source of truth for paths). */
export function toOrchestrationConfig(config: ApiConfig): OrchestrationConfig {
  return {
    temporalAddress: config.temporalAddress,
    temporalNamespace: process.env.TEMPORAL_NAMESPACE ?? 'default',
    taskQueue: process.env.TEMPORAL_TASK_QUEUE ?? 'factory-runs',
    databaseUrl: config.databaseUrl,
    factoryRoot: config.factoryRoot,
    runsDir: config.runsDir,
    proxyPublicUrl: config.proxyPublicUrl,
    providerBaseUrl: config.providerBaseUrl,
    providerKey: config.providerKey,
    defaultRunner: process.env.RUNNER_BACKEND === 'local' ? 'local' : 'docker',
    permissionTimeoutMs: config.permissionTimeoutMs,
    maxConcurrentActivityTaskExecutions: intFromEnv(
      process.env.WORKER_MAX_CONCURRENT_ACTIVITY_TASKS,
      100,
    ),
    maxConcurrentWorkflowTaskExecutions: intFromEnv(
      process.env.WORKER_MAX_CONCURRENT_WORKFLOW_TASKS,
      100,
    ),
  };
}
