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

export const modelNotAllowed = (model: string, allowed: string[]): ApiError =>
  new ApiError('model_not_allowed', 403, `model "${model}" is not allowed for this run`, {
    model,
    allowed,
  });

export const workItemNotFound = (workItemId: string): ApiError =>
  new ApiError('work_item_not_found', 404, `work item "${workItemId}" does not exist`, {
    workItemId,
  });

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
