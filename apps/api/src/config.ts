import { join, resolve } from 'node:path';
import type { HarnessId, OrchestrationConfig, RunnerKindName } from '@factory/orchestration';

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
  /** SLA for an undecided stage gate before the configured fallback applies. */
  gateSlaMs: number;
  /** Judge backend: `stub` (credential-free) or `openai` (OpenAI-compatible endpoint). */
  scoringJudgeMode: 'stub' | 'openai';
  /** Hard daily cap on judge scores per factory. */
  scoringMaxScoresPerDay: number;
  /** Minimum time between judge scores for one scorer; 0 disables cadence. */
  scoringCadenceMs: number;
  scoringCron: string;
  scoringWindowDays: number;
  /** Optional benchmark harness override (CI/smoke use `fake`; production uses the factory default). */
  benchmarkHarness: HarnessId | null;
  benchmarkRunner: RunnerKindName | null;
  benchmarkConcurrency: number;
  benchmarkDefaultRunCostUsd: number;
  benchmarkConfirmThresholdUsd: number;
  benchmarkMaxCostUsd: number;
  benchmarkPassThreshold: number;
  /** Minimum distinct scored runs before the improvement observer may propose. */
  improvementMinScoredRuns: number;
  /** Scored-corpus window for an improvement run, in days. */
  improvementWindowDays: number;
  /** Cap on proposals kept after dedupe, ranked by impact. */
  improvementMaxProposals: number;
  /** Owner of the git repo that hosts definitions (fake forge in CI). */
  definitionRepoOwner: string;
  /** Merge queue (ADR-022): pull requests merged per batch. */
  mergeBatchSize: number;
  /** How long the merged stack may stay pending before `checks_timeout`. */
  mergeChecksTimeoutMs: number;
  mergeChecksPollMs: number;
  mergeMaxBatches: number;
  mergeIdleIntervalMs: number;
  mergeIdleCycles: number;
  /** Candidate trees kept after a terminal rollout (harden-runtime). */
  canaryKeepTrees: number;
  /** Timeout for the optional promotion deploy hook. */
  canaryDeployTimeoutMs: number;
  /**
   * Webhooks (ADR-023): hard cap on a delivery body. Anything larger is rejected with
   * `payload_too_large` before parsing.
   */
  webhookMaxBytes: number;
  /** Secret *name* holding the GitHub webhook HMAC key when an integration has none. */
  webhookSecretRef: string;
  /** GitHub API base URL (a stub/fake endpoint in tests and dry-run demos). */
  githubBaseUrl: string;
  /** `GITHUB_DRY_RUN=1`: no repository mutation, synthetic results + intended actions. */
  githubDryRun: boolean;
  /** Public base URL of this API, used to render the webhook URL in the console. */
  webhookPublicUrl: string;
  /**
   * Console auth (change `add-console-auth`). `AUTH_REQUIRED=1` (compose) makes a session
   * mandatory; the default off keeps unit/integration tests and local development in the
   * old single-user mode.
   */
  authRequired: boolean;
  /** `AUTH_COOKIE_SECURE=1` marks the session cookie `Secure` (HTTPS deployments). */
  authCookieSecure: boolean;
  /** Bootstrap admin identity, created once when no user exists. */
  adminEmail: string;
  /** Bootstrap admin password; when unset a random one is generated and logged once. */
  adminPassword?: string;
  /** Forge backend base URL (`GITHUB_API_BASE_URL`) for personal-org provisioning. */
  forgeApiBaseUrl: string;
  /** Forge admin token (`GITHUB_TOKEN`); used only for best-effort org provisioning. */
  forgeAdminToken: string;
  /** Personal org prefix (`FORGEJO_ORG_PREFIX`, default `u-`). */
  forgeOrgPrefix: string;
}

function boolFromEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  return value === '1' || value.toLowerCase() === 'true';
}

function intFromEnv(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

function numberFromEnv(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function harnessFromEnv(value: string | undefined): HarnessId | null {
  const allowed: HarnessId[] = ['opencode', 'claude-code', 'codex', 'gemini', 'generic-cli', 'fake'];
  return allowed.includes(value as HarnessId) ? (value as HarnessId) : null;
}

function runnerFromEnv(value: string | undefined): RunnerKindName | null {
  const allowed: RunnerKindName[] = ['local-docker', 'local-process', 'fake'];
  return allowed.includes(value as RunnerKindName) ? (value as RunnerKindName) : null;
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
    gateSlaMs: intFromEnv(env.GATE_SLA_MS, 24 * 60 * 60 * 1000),
    scoringJudgeMode: env.SCORING_JUDGE_MODE === 'openai' ? 'openai' : 'stub',
    scoringMaxScoresPerDay: intFromEnv(env.SCORING_MAX_SCORES_PER_DAY, 200),
    scoringCadenceMs: intFromEnv(env.SCORING_CADENCE_MS, 0),
    scoringCron: env.SCORING_CRON ?? '0 3 * * *',
    scoringWindowDays: intFromEnv(env.SCORING_WINDOW_DAYS, 1),
    benchmarkHarness: harnessFromEnv(env.BENCHMARK_HARNESS),
    benchmarkRunner: runnerFromEnv(env.BENCHMARK_RUNNER),
    benchmarkConcurrency: intFromEnv(env.BENCHMARK_CONCURRENCY, 2),
    benchmarkDefaultRunCostUsd: numberFromEnv(env.BENCHMARK_DEFAULT_RUN_COST_USD, 0.5),
    benchmarkConfirmThresholdUsd: numberFromEnv(env.BENCHMARK_CONFIRM_THRESHOLD_USD, 5),
    benchmarkMaxCostUsd: numberFromEnv(env.BENCHMARK_MAX_COST_USD, 25),
    benchmarkPassThreshold: numberFromEnv(env.BENCHMARK_PASS_THRESHOLD, 0.8),
    improvementMinScoredRuns: intFromEnv(env.IMPROVEMENT_MIN_SCORED_RUNS, 3),
    improvementWindowDays: intFromEnv(env.IMPROVEMENT_WINDOW_DAYS, 30),
    improvementMaxProposals: intFromEnv(env.IMPROVEMENT_MAX_PROPOSALS, 5),
    definitionRepoOwner: env.DEFINITION_REPO_OWNER ?? 'factory',
    mergeBatchSize: intFromEnv(env.MERGE_BATCH_SIZE, 2),
    mergeChecksTimeoutMs: intFromEnv(env.MERGE_CHECKS_TIMEOUT_MS, 10 * 60 * 1000),
    mergeChecksPollMs: intFromEnv(env.MERGE_CHECKS_POLL_MS, 2_000),
    mergeMaxBatches: intFromEnv(env.MERGE_MAX_BATCHES, 25),
    mergeIdleIntervalMs: intFromEnv(env.MERGE_IDLE_INTERVAL_MS, 30_000),
    mergeIdleCycles: intFromEnv(env.MERGE_IDLE_CYCLES, 2),
    canaryKeepTrees: intFromEnv(env.CANARY_KEEP_TREES, 3),
    canaryDeployTimeoutMs: intFromEnv(env.CANARY_DEPLOY_TIMEOUT_MS, 60_000),
    webhookMaxBytes: intFromEnv(env.WEBHOOK_MAX_BYTES, 1_000_000),
    webhookSecretRef: env.GITHUB_WEBHOOK_SECRET_REF ?? 'GITHUB_WEBHOOK_SECRET',
    githubBaseUrl: env.GITHUB_API_BASE_URL ?? 'https://api.github.com',
    githubDryRun: boolFromEnv(env.GITHUB_DRY_RUN, false),
    webhookPublicUrl: env.WEBHOOK_PUBLIC_URL ?? 'http://localhost:8080',
    authRequired: boolFromEnv(env.AUTH_REQUIRED, false),
    authCookieSecure: boolFromEnv(env.AUTH_COOKIE_SECURE, false),
    adminEmail: env.FACTORY_ADMIN_EMAIL ?? 'admin@factory.local',
    ...(env.FACTORY_ADMIN_PASSWORD ? { adminPassword: env.FACTORY_ADMIN_PASSWORD } : {}),
    // Deliberately no default: an unset forge URL means "do not provision personal orgs",
    // so a laptop never accidentally creates orgs on the public GitHub API.
    forgeApiBaseUrl: env.GITHUB_API_BASE_URL ?? '',
    forgeAdminToken: env.GITHUB_TOKEN ?? '',
    forgeOrgPrefix: env.FORGEJO_ORG_PREFIX ?? 'u-',
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
    runnerWorkspaceMode: process.env.RUNNER_WORKSPACE_MODE === 'copy' ? 'copy' : 'bind',
    permissionTimeoutMs: config.permissionTimeoutMs,
    gateSlaMs: config.gateSlaMs,
    loopLimit: intFromEnv(process.env.FACTORY_LOOP_LIMIT, 3),
    maxStagesPerRun: intFromEnv(process.env.FACTORY_CONTINUE_AFTER_STAGES, 10),
    maxConcurrentActivityTaskExecutions: intFromEnv(
      process.env.WORKER_MAX_CONCURRENT_ACTIVITY_TASKS,
      100,
    ),
    maxConcurrentWorkflowTaskExecutions: intFromEnv(
      process.env.WORKER_MAX_CONCURRENT_WORKFLOW_TASKS,
      100,
    ),
    scoringJudgeMode: config.scoringJudgeMode,
    scoringMaxScoresPerDay: config.scoringMaxScoresPerDay,
    scoringCadenceMs: config.scoringCadenceMs,
    scoringCron: config.scoringCron,
    scoringWindowDays: config.scoringWindowDays,
    benchmarkConcurrency: config.benchmarkConcurrency,
    benchmarkDefaultRunCostUsd: config.benchmarkDefaultRunCostUsd,
    benchmarkConfirmThresholdUsd: config.benchmarkConfirmThresholdUsd,
    benchmarkMaxCostUsd: config.benchmarkMaxCostUsd,
    benchmarkPassThreshold: config.benchmarkPassThreshold,
    improvementMinScoredRuns: config.improvementMinScoredRuns,
    improvementWindowDays: config.improvementWindowDays,
    improvementMaxProposals: config.improvementMaxProposals,
    definitionRepoOwner: config.definitionRepoOwner,
    mergeBatchSize: config.mergeBatchSize,
    mergeChecksTimeoutMs: config.mergeChecksTimeoutMs,
    mergeChecksPollMs: config.mergeChecksPollMs,
    mergeMaxBatches: config.mergeMaxBatches,
    mergeIdleIntervalMs: config.mergeIdleIntervalMs,
    mergeIdleCycles: config.mergeIdleCycles,
    canaryKeepTrees: config.canaryKeepTrees,
    canaryDeployTimeoutMs: config.canaryDeployTimeoutMs,
  };
}
