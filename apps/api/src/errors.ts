/**
 * One error envelope for the whole API: `{code, message, details?}`.
 * Codes are stable strings (shared vocabulary with `@factory/core` validation codes and
 * the adapter/runner error codes) so clients can branch on them without parsing prose.
 */
export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: string, status: number, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export interface ErrorEnvelope {
  code: string;
  message: string;
  details?: unknown;
}

export function toEnvelope(error: unknown): { status: number; body: ErrorEnvelope } {
  if (error instanceof ApiError) {
    return {
      status: error.status,
      body: {
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
      },
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { status: 500, body: { code: 'internal_error', message } };
}

export const factoryNotFound = (factory: string): ApiError =>
  new ApiError('factory_not_found', 404, `factory "${factory}" does not exist`, { factory });

export const runNotFound = (runId: string): ApiError =>
  new ApiError('run_not_found', 404, `run "${runId}" does not exist`, { runId });

export const scoreNotFound = (scoreId: string): ApiError =>
  new ApiError('score_not_found', 404, `score "${scoreId}" does not exist`, { scoreId });

export const definitionInvalid = (factory: string, errors: unknown): ApiError =>
  new ApiError('definition_invalid', 422, `factory "${factory}" does not validate`, {
    factory,
    errors,
  });

export const permissionNotFound = (runId: string, requestId: string): ApiError =>
  new ApiError('permission_not_found', 404, `no permission request "${requestId}" for run "${runId}"`, {
    runId,
    requestId,
  });

export const unsupportedCapability = (message: string, details?: unknown): ApiError =>
  new ApiError('unsupported_capability', 409, message, details);

export const invalidRequest = (message: string, details?: unknown): ApiError =>
  new ApiError('invalid_request', 400, message, details);

export const unauthorized = (message: string, details?: unknown): ApiError =>
  new ApiError('unauthorized', 401, message, details);

/**
 * A definition declares `model: env:NAME` but the variable is unset (ADR-028). Starting
 * the run would send the literal `env:...` string upstream, so it is refused instead.
 */
export const modelUnresolved = (ref: string, envName: string): ApiError =>
  new ApiError(
    'model_unresolved',
    422,
    `model reference "${ref}" is unresolved: environment variable "${envName}" is not set`,
    { ref, env: envName },
  );

export const factoryBudgetExhausted = (
  factory: string,
  capUsd: number,
  spentUsd: number,
): ApiError =>
  new ApiError(
    'factory_budget_exhausted',
    409,
    `factory "${factory}" has spent $${spentUsd.toFixed(2)} of its $${capUsd.toFixed(2)} cap; new work is refused`,
    { factory, capUsd, spentUsd },
  );

export const modelNotAllowed = (model: string, allowed: string[]): ApiError =>
  new ApiError('model_not_allowed', 403, `model "${model}" is not allowed for this run`, {
    model,
    allowed,
  });

export const workItemNotFound = (workItemId: string): ApiError =>
  new ApiError('work_item_not_found', 404, `work item "${workItemId}" does not exist`, {
    workItemId,
  });

/** A request cannot apply in the resource's current state (e.g. cancelling a done item). */
export const invalidState = (message: string, details?: unknown): ApiError =>
  new ApiError('invalid_state', 409, message, details);

/**
 * A work item cannot be retried: it is `active` (a retry already re-opened it) or `done`.
 * The message names the current status (spec `factory-loop` › Not retryable).
 */
export const workItemNotRetryable = (workItemId: string, status: string): ApiError =>
  new ApiError(
    'work_item_not_retryable',
    409,
    `work item "${workItemId}" is ${status}; only an escalated, failed, blocked or cancelled item can be retried`,
    { workItemId, status },
  );

export const gateNotFound = (workItemId: string, stage: string): ApiError =>
  new ApiError(
    'gate_not_found',
    404,
    `work item "${workItemId}" has no pending gate for stage "${stage}"`,
    { workItemId, stage },
  );

export const invalidStageGraph = (node: string, message: string): ApiError =>
  new ApiError('invalid_stage_graph', 422, message, { node });

export const spawnNotAllowed = (
  stage: string,
  agent: string,
  spawner: string | null,
): ApiError =>
  new ApiError(
    'spawn_not_allowed',
    409,
    `agent "${agent}" cannot be spawned by ${spawner ?? 'the system'} for stage "${stage}"`,
    { stage, agent, spawner },
  );

export const autonomyRefused = (message: string, details?: unknown): ApiError =>
  new ApiError('autonomy_refused', 409, message, details);

export const benchmarkNotFound = (benchmarkRunId: string): ApiError =>
  new ApiError('benchmark_not_found', 404, `benchmark "${benchmarkRunId}" does not exist`, {
    benchmarkRunId,
  });

export const benchmarkSuiteNotFound = (factory: string, suite: string): ApiError =>
  new ApiError(
    'benchmark_suite_not_found',
    404,
    `factory "${factory}" has no benchmark suite "${suite}"`,
    { factory, suite },
  );

export const proposalNotFound = (proposalId: string): ApiError =>
  new ApiError('proposal_not_found', 404, `proposal "${proposalId}" does not exist`, {
    proposalId,
  });

export const proposalNotDecidable = (proposalId: string, status: string): ApiError =>
  new ApiError(
    'proposal_not_decidable',
    409,
    `proposal "${proposalId}" is ${status}; only an open proposal can be accepted or rejected`,
    { proposalId, status },
  );

export const proposalNotAccepted = (proposalId: string, status: string): ApiError =>
  new ApiError(
    'proposal_not_accepted',
    409,
    `proposal "${proposalId}" is ${status}; accept it before applying`,
    { proposalId, status },
  );

/** Phase 5a legacy refusal: kept for old proposals/readers; canary rollout is live in 5b. */
export const canaryNotAvailable = (details?: unknown): ApiError =>
  new ApiError(
    'canary_not_available',
    409,
    'the proposal has no composed candidate to roll out',
    { ...(details && typeof details === 'object' ? details : {}) },
  );

/** A factory already has an active canary rollout; only one may route work at a time. */
export const canaryActive = (factory: string, rolloutId: string): ApiError =>
  new ApiError(
    'canary_active',
    409,
    `factory "${factory}" already has an active canary rollout`,
    { factory, rolloutId },
  );

/** Manual promote/rollback found nothing to act on. */
export const noActiveCanary = (factory: string, statuses: string[]): ApiError =>
  new ApiError(
    'no_active_canary',
    409,
    `factory "${factory}" has no canary rollout in ${statuses.join(' or ')}`,
    { factory, statuses },
  );

export const lessonNotFound = (lessonId: string): ApiError =>
  new ApiError('lesson_not_found', 404, `lesson "${lessonId}" does not exist`, { lessonId });

/** A verify gate cannot approve while enforced validation evidence is missing (item 1). */
export const validationIncomplete = (workItemId: string, missing: string[]): ApiError =>
  new ApiError(
    'validation_incomplete',
    409,
    `validation contract is incomplete for work item "${workItemId}"`,
    { workItemId, missing },
  );

/** Enabling autonomy is refused while the factory/repository readiness is below `ready`. */
export const readinessNotReady = (
  factory: string,
  report: { status: string; score: number; checks: { id: string; passed: boolean }[] },
): ApiError =>
  new ApiError(
    'readiness_not_ready',
    409,
    `factory "${factory}" readiness is ${report.status} (${report.score}/100)`,
    {
      factory,
      status: report.status,
      score: report.score,
      failing: report.checks.filter((check) => !check.passed).map((check) => check.id),
    },
  );


/** Above the confirmation threshold, a run must be explicitly confirmed. */
export const costConfirmationRequired = (estimate: unknown): ApiError =>
  new ApiError(
    'cost_confirmation_required',
    409,
    'the benchmark estimate exceeds the confirmation threshold; re-send with `confirm: true`',
    { estimate },
  );

/** The autonomy gate refuses because no passing attestation matches the running version. */
export const benchmarkAttestationMissing = (
  factory: string,
  definitionCommit: string,
  suites: unknown,
): ApiError =>
  new ApiError(
    'benchmark_attestation_missing',
    409,
    `enabling autonomy requires a passing, calibrated benchmark attestation for definition ${definitionCommit.slice(0, 8)}; none matches the current configuration hash (pass an explicit override {actor, reason} to proceed)`,
    { factory, definitionCommit, suites },
  );
