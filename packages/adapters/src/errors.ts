/** The single error shape every adapter and runner uses: `{code, message, details?}`. */
export interface FactoryErrorShape {
  code: string;
  message: string;
  details?: unknown;
}

export const ADAPTER_ERROR_CODES = [
  /** The harness did not answer its readiness probe within the timeout. */
  'harness_unreachable',
  /** The harness answered, but with an error status or a malformed payload. */
  'harness_error',
  /** The caller asked for something the adapter's capabilities do not cover. */
  'unsupported_capability',
  'session_not_found',
  'permission_not_found',
  'invalid_response',
  'aborted',
] as const;

export type AdapterErrorCode = (typeof ADAPTER_ERROR_CODES)[number];

export class AdapterError extends Error {
  readonly code: AdapterErrorCode;
  readonly details?: unknown;

  constructor(code: AdapterErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'AdapterError';
    this.code = code;
    this.details = details;
  }

  toJSON(): FactoryErrorShape {
    return this.details === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, details: this.details };
  }
}

export function isAdapterError(error: unknown): error is AdapterError {
  return error instanceof AdapterError;
}

export function toFactoryError(error: unknown): FactoryErrorShape {
  if (error instanceof AdapterError) return error.toJSON();
  if (error instanceof Error) return { code: 'harness_error', message: error.message };
  return { code: 'harness_error', message: String(error) };
}
