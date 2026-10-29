/**
 * Stable forge error codes. They are part of the interface contract: the orchestrator
 * records them on the work item and the API returns them in the standard error envelope.
 */
export const FORGE_ERROR_CODES = [
  /** A stage tried to write to (or create) the default branch. */
  'protected_branch',
  /** Repo, branch, commit or pull request does not exist. */
  'not_found',
  /** The requested operation is not valid for the current state (e.g. merging a merged PR). */
  'invalid_state',
  /** Merge refused because required checks are not green. */
  'checks_not_green',
  /** Merge refused because the branch has no commits ahead of the base. */
  'no_commits',
] as const;

export type ForgeErrorCode = (typeof FORGE_ERROR_CODES)[number];

export class ForgeError extends Error {
  readonly code: ForgeErrorCode;
  readonly details?: unknown;

  constructor(code: ForgeErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'ForgeError';
    this.code = code;
    this.details = details;
  }
}

export function isForgeError(error: unknown): error is ForgeError {
  return error instanceof ForgeError;
}
