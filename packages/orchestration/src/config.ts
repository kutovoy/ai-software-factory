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
  /** Enable the remote-runner control plane (Linux agent MVP). */
  remoteRunnerEnabled: boolean;
  remoteRunnerPlatform: string;
  remoteRunnerPool: string;
  /** How long an activity waits for one agent command result. */
  remoteCommandTimeoutMs: number;
  /** Lease TTL for a remote sandbox; the agent re-attaches by runnerId. */
  remoteLeaseTtlMs: number;
  /** Worker loop cadence for heartbeat-age alerts and lease expiry. */
  remoteAlertIntervalMs: number;
  /** Agent heartbeat interval advertised at enrollment. */
  remoteHeartbeatIntervalMs: number;
  /** Clone URL a remote agent can use; remote runs cannot read the central path. */
  runnerRepoUrl?: string;
  /**
   * User-defined docker network the docker backend attaches sandboxes to. Unset means the
   * sandbox publishes an ephemeral 127.0.0.1 port (correct for a host worker only).
   */
  runnerNetwork?: string;
  /**
   * How the docker backend hands the workspace to the sandbox: `bind` (host worker) or
   * `copy` (worker runs in a container, so the daemon cannot see its filesystem).
   */
  runnerWorkspaceMode: 'bind' | 'copy';
  /** How long a `permission.requested` may wait before it is auto-denied. */
  permissionTimeoutMs: number;
  /** SLA for an undecided stage gate before the configured fallback applies. */
  gateSlaMs: number;
  /** `request_changes` loop limit before the item escalates to a human. */
  loopLimit: number;
  /** `FactoryWorkflow` calls `continueAsNew` after this many completed stages. */
  maxStagesPerRun: number;
  /**
   * Worker concurrency (ADR-013). Each *streaming* run holds one activity slot; a run
   * waiting for a human decision holds none. Defaults are Temporal's own defaults, raised
   * from the old hardcoded 8 that starved the queue.
   */
  maxConcurrentActivityTaskExecutions: number;
  maxConcurrentWorkflowTaskExecutions: number;
  /** Judge backend: `stub` (credential-free) or `openai` (OpenAI-compatible endpoint). */
  scoringJudgeMode: 'stub' | 'openai';
  /** Hard daily cap on judge scores per factory (deterministic scoring is free). */
  scoringMaxScoresPerDay: number;
  /** Minimum time between judge scores for one scorer; 0 disables cadence. */
  scoringCadenceMs: number;
  /** Cron for the per-factory scoring schedule. */
  scoringCron: string;
  /** Default window (days) for scheduled scoring. */
  scoringWindowDays: number;
  /** Max concurrent benchmark trials (child runs) per benchmark workflow. */
  benchmarkConcurrency: number;
  /** Fallback per-run cost when a factory has no comparable terminal runs. */
  benchmarkDefaultRunCostUsd: number;
  /** Estimates above this require an explicit `confirm: true`. */
  benchmarkConfirmThresholdUsd: number;
  /** Default hard cap for a benchmark run; aborts remaining trials. */
  benchmarkMaxCostUsd: number;
  /** Pass rate a calibrated benchmark must reach to attest. */
  benchmarkPassThreshold: number;
  /** Minimum distinct scored runs before the improvement observer may propose. */
  improvementMinScoredRuns: number;
  /** Scored-corpus window for an improvement run, in days. */
  improvementWindowDays: number;
  /** Cap on proposals kept after dedupe, ranked by impact. */
  improvementMaxProposals: number;
  /** Owner of the git repo that hosts factory definitions (fake forge in CI). */
  definitionRepoOwner: string;
  /** Merge queue (ADR-022): pull requests merged per batch. */
  mergeBatchSize: number;
  /** How long the merged stack may stay pending before `checks_timeout`. */
  mergeChecksTimeoutMs: number;
  /** Poll interval while gating the merged stack. */
  mergeChecksPollMs: number;
  /** Batches one queue workflow run processes before completing. */
  mergeMaxBatches: number;
  /** Durable wait between batches when the queue is empty. */
  mergeIdleIntervalMs: number;
  /** Empty waits allowed before the queue workflow completes. */
  mergeIdleCycles: number;
  /** Candidate definition trees kept after a terminal rollout (harden-runtime, task 5.1). */
  canaryKeepTrees: number;
  /** Timeout for the optional promotion `deployHook` command. */
  canaryDeployTimeoutMs: number;
  /**
   * Orphan runner reaper. The worker compares label-managed sandbox containers with the
   * run read model and Temporal, and removes containers whose run is terminal/missing.
   */
  runnerReaperEnabled: boolean;
  runnerReaperIntervalMs: number;
  /** Log actions without removing anything; use for a first rollout. */
  runnerReaperDryRun: boolean;
  /** A container older than this with no live workflow is considered orphaned. */
  runnerReaperMaxAgeMs: number;
  /** Do not remove a container whose run just started; avoids a Temporal visibility race. */
  runnerReaperGraceMs: number;
}

function intFromEnv(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

function numberFromEnv(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
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
    remoteRunnerEnabled: env.REMOTE_RUNNER === '1' || env.REMOTE_RUNNER?.toLowerCase() === 'true',
    remoteRunnerPlatform: env.REMOTE_RUNNER_PLATFORM ?? 'linux',
    remoteRunnerPool: env.REMOTE_RUNNER_POOL ?? 'default',
    remoteCommandTimeoutMs: intFromEnv(env.REMOTE_COMMAND_TIMEOUT_MS, 120_000),
    remoteLeaseTtlMs: intFromEnv(env.REMOTE_LEASE_TTL_MS, 15 * 60 * 1000),
    remoteAlertIntervalMs: intFromEnv(env.REMOTE_ALERT_INTERVAL_MS, 30_000),
    remoteHeartbeatIntervalMs: intFromEnv(env.REMOTE_HEARTBEAT_INTERVAL_MS, 15_000),
    ...(env.RUNNER_REPO_URL ? { runnerRepoUrl: env.RUNNER_REPO_URL } : {}),
    ...(env.RUNNER_NETWORK ? { runnerNetwork: env.RUNNER_NETWORK } : {}),
    runnerWorkspaceMode: env.RUNNER_WORKSPACE_MODE === 'copy' ? 'copy' : 'bind',
    permissionTimeoutMs: intFromEnv(env.PERMISSION_TIMEOUT_MS, 30 * 60 * 1000),
    // A gate may wait for days; the SLA only decides the fallback, not the wait.
    gateSlaMs: intFromEnv(env.GATE_SLA_MS, 24 * 60 * 60 * 1000),
    loopLimit: intFromEnv(env.FACTORY_LOOP_LIMIT, 3),
    maxStagesPerRun: intFromEnv(env.FACTORY_CONTINUE_AFTER_STAGES, 10),
    // Activities are I/O-bound (harness streams, DB writes), so the Temporal default of
    // 100 is a sane ceiling; workflow tasks are cheap and short.
    maxConcurrentActivityTaskExecutions: intFromEnv(env.WORKER_MAX_CONCURRENT_ACTIVITY_TASKS, 100),
    maxConcurrentWorkflowTaskExecutions: intFromEnv(env.WORKER_MAX_CONCURRENT_WORKFLOW_TASKS, 100),
    scoringJudgeMode: env.SCORING_JUDGE_MODE === 'openai' ? 'openai' : 'stub',
    scoringMaxScoresPerDay: intFromEnv(env.SCORING_MAX_SCORES_PER_DAY, 200),
    scoringCadenceMs: intFromEnv(env.SCORING_CADENCE_MS, 0),
    scoringCron: env.SCORING_CRON ?? '0 3 * * *',
    scoringWindowDays: intFromEnv(env.SCORING_WINDOW_DAYS, 1),
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
    runnerReaperEnabled: env.RUNNER_REAPER !== '0',
    runnerReaperIntervalMs: intFromEnv(env.RUNNER_REAPER_INTERVAL_MS, 5 * 60 * 1000),
    runnerReaperDryRun: env.RUNNER_REAPER_DRY_RUN === '1',
    runnerReaperMaxAgeMs: intFromEnv(env.RUNNER_REAPER_MAX_AGE_MS, 6 * 60 * 60 * 1000),
    runnerReaperGraceMs: intFromEnv(env.RUNNER_REAPER_GRACE_MS, 5 * 60 * 1000),
  };
}
