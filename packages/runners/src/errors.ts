/** The single error shape every adapter and runner uses: `{code, message, details?}`. */
export interface FactoryErrorShape {
  code: string;
  message: string;
  details?: unknown;
}

export const RUNNER_ERROR_CODES = [
  /** The sandbox could not be created or the harness never became ready. */
  'runner_unavailable',
  /**
   * A requested sandbox profile (`RUNNER_SANDBOX=bwrap`) cannot be honoured on this host.
   * Same identifier as the runner step event, so the UI can point at one cause.
   */
  'runner.sandbox_unavailable',
  'runner_not_found',
  'exec_failed',
  'exec_timeout',
  'artifact_not_found',
  /** Docker CLI/server is not usable. */
  'docker_unavailable',
  /** A secret that is not on the execution allowlist was requested. */
  'secret_not_granted',
  /** Inference credentials may never enter the sandbox. */
  'inference_credential_forbidden',
  'invalid_spec',
  'aborted',
] as const;

export type RunnerErrorCode = (typeof RUNNER_ERROR_CODES)[number];

export class RunnerError extends Error {
  readonly code: RunnerErrorCode;
  readonly details?: unknown;

  constructor(code: RunnerErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'RunnerError';
    this.code = code;
    this.details = details;
  }

  toJSON(): FactoryErrorShape {
    return this.details === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, details: this.details };
  }
}

export function isRunnerError(error: unknown): error is RunnerError {
  return error instanceof RunnerError;
}

export function toFactoryError(error: unknown): FactoryErrorShape {
  if (error instanceof RunnerError) return error.toJSON();
  if (error instanceof Error) return { code: 'runner_unavailable', message: error.message };
  return { code: 'runner_unavailable', message: String(error) };
}
