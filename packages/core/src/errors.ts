import type { z } from 'zod';

/**
 * The only error shape the loader, CLI and DB index agree on.
 * `pointer` is a JSON pointer into the document (`/` for the document root).
 */
export interface ValidationError {
  code: string;
  file: string;
  pointer: string;
  message: string;
}

export const ERROR_CODES = [
  'missing_file',
  'invalid_yaml',
  'missing_frontmatter',
  'unterminated_frontmatter',
  'unknown_file',
  'duplicate_identity',
  'unsupported_schema_version',
  'missing_field',
  'unknown_field',
  'invalid_value',
  'invalid_repository',
  'exclusive_inference',
  'missing_inference',
  'invalid_gate',
  'invalid_sampling_rate',
  'invalid_sha',
  'unknown_reference',
  'invalid_cron',
  'invalid_scorer_labels',
  'benchmark_task_mismatch',
  'too_many_configurations',
  'duplicate_tasks',
  'duplicate_configurations',
  'invalid_stage_graph',
  'dirty_worktree',
  'secret_inline_rejected',
  'unknown_mcp_server',
  /**
   * The runtime loader refuses a definition without a stable `fac_<ulid>` id
   * (change `add-factory-identity`).
   */
  'factory_id_missing',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/**
 * Non-fatal validation findings (spec `secrets` › definition validation). A warning never
 * makes a definition invalid: a fresh checkout has no registry to compare against.
 */
export const WARNING_CODES = ['secret_unregistered', 'model_env_unresolved'] as const;
export type WarningCode = (typeof WARNING_CODES)[number];

export interface ValidationWarning {
  code: WarningCode;
  file: string;
  pointer: string;
  message: string;
}

export function validationWarning(
  code: WarningCode,
  file: string,
  pointer: string,
  message: string,
): ValidationWarning {
  return { code, file, pointer, message };
}

export function validationError(
  code: ErrorCode,
  file: string,
  pointer: string,
  message: string,
): ValidationError {
  return { code, file, pointer, message };
}

export class DefinitionValidationError extends Error {
  readonly errors: ValidationError[];

  constructor(errors: ValidationError[]) {
    super(`${errors.length} validation error(s)`);
    this.name = 'DefinitionValidationError';
    this.errors = errors;
  }
}

export function toPointer(path: readonly (string | number)[]): string {
  if (path.length === 0) return '/';
  return `/${path
    .map((part) => String(part).replace(/~/g, '~0').replace(/\//g, '~1'))
    .join('/')}`;
}

function codeForIssue(issue: z.ZodIssue): ErrorCode {
  const explicit = (issue as { params?: { errorCode?: string } }).params?.errorCode;
  if (explicit && (ERROR_CODES as readonly string[]).includes(explicit)) {
    return explicit as ErrorCode;
  }
  switch (issue.code) {
    case 'unrecognized_keys':
      return 'unknown_field';
    case 'invalid_type':
      return issue.received === 'undefined' ? 'missing_field' : 'invalid_value';
    default:
      return 'invalid_value';
  }
}

export function mapZodIssues(issues: readonly z.ZodIssue[], file: string): ValidationError[] {
  return issues.map((issue) => ({
    code: codeForIssue(issue),
    file,
    pointer: toPointer(issue.path),
    message: issue.message,
  }));
}
