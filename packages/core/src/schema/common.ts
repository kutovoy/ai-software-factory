import { z } from 'zod';
import { isEnvModelRef, modelEnvName } from '../model/ref';

export const SCHEMA_VERSION = 'v1alpha1';
export const SUPPORTED_SCHEMA_VERSIONS = [SCHEMA_VERSION] as const;

/** The stages the gates resolver knows about. */
export const STAGES = ['spec', 'plan', 'implement', 'review', 'pr_review', 'deploy'] as const;
export type Stage = (typeof STAGES)[number];

export const MERGE_POLICIES = [
  'human',
  'auto_on_green',
  'auto_after_n_approvals',
  'disabled',
] as const;
export type MergePolicy = (typeof MERGE_POLICIES)[number];

export const HARNESS_TYPES = [
  'opencode',
  'claude-code',
  'codex',
  'gemini',
  'generic-cli',
] as const;
export type HarnessType = (typeof HARNESS_TYPES)[number];

export const INTEGRATIONS = [
  'github',
  'gitlab',
  'slack',
  'linear',
  'jira',
  'microsoft-teams',
] as const;

export const GATE_RE = /^(human|agent|policy:[a-z][a-z0-9_-]*)$/;
export const SECRET_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export type Gate = 'human' | 'agent' | `policy:${string}`;

export function isGate(value: unknown): value is Gate {
  return typeof value === 'string' && GATE_RE.test(value);
}

const CRON_FIELD_RE = /^[\d*/,\-]+$/;

/** Minimal 5-field cron validation: shape only, no scheduler semantics. */
export function isValidCron(expression: string): boolean {
  const fields = expression.trim().split(/\s+/);
  return fields.length === 5 && fields.every((field) => CRON_FIELD_RE.test(field));
}

export function addIssue(
  ctx: z.RefinementCtx,
  errorCode: string,
  message: string,
  path?: (string | number)[],
): void {
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    message,
    params: { errorCode },
    ...(path ? { path } : {}),
  });
}

/** A string with a regex check that reports a stable machine code. */
export function codedString(regex: RegExp, errorCode: string, message: string) {
  return z.string().superRefine((value, ctx) => {
    if (!regex.test(value)) addIssue(ctx, errorCode, message);
  });
}

export const secretNameSchema = codedString(
  SECRET_NAME_RE,
  'invalid_value',
  'secret name must match [A-Za-z_][A-Za-z0-9_]*',
);

export const gateSchema = codedString(
  GATE_RE,
  'invalid_gate',
  'gate must be "human", "agent" or "policy:<name>"',
);

export const gatesSchema = z
  .object(
    Object.fromEntries(STAGES.map((stage) => [stage, gateSchema.optional()])) as Record<
      string,
      z.ZodTypeAny
    >,
  )
  .strict();

export const harnessAuthSchema = z
  .object({
    source: z.enum(['managedSecret', 'workerEnvironment']),
    secretName: secretNameSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.source === 'managedSecret' && !value.secretName) {
      addIssue(
        ctx,
        'missing_field',
        'auth.source "managedSecret" requires secretName',
        ['secretName'],
      );
    }
    if (value.source === 'workerEnvironment' && value.secretName) {
      addIssue(
        ctx,
        'invalid_value',
        'auth.source "workerEnvironment" must not declare secretName',
        ['secretName'],
      );
    }
  });

/**
 * A model is a literal string or an environment reference (`env:NAME`, ADR-028).
 * `env:` with no valid POSIX variable name is an `invalid_value`, not a literal.
 */
export const modelSchema = z.string().min(1).superRefine((value, ctx) => {
  if (!isEnvModelRef(value)) return;
  if (modelEnvName(value) !== null) return;
  addIssue(
    ctx,
    'invalid_value',
    'model env reference must be "env:" followed by [A-Z_][A-Z0-9_]*',
  );
});

export const harnessSchema = z
  .object({
    type: z.enum(HARNESS_TYPES),
    model: modelSchema,
    reasoningLevel: z.enum(['low', 'medium', 'high']).optional(),
    auth: harnessAuthSchema.optional(),
  })
  .strict();

function refineInference(
  value: { model?: string; harness?: unknown },
  ctx: z.RefinementCtx,
  required: boolean,
): void {
  const hasModel = value.model !== undefined;
  const hasHarness = value.harness !== undefined;
  if (hasModel && hasHarness) {
    addIssue(ctx, 'exclusive_inference', 'declare exactly one of model or harness, not both');
  }
  if (required && !hasModel && !hasHarness) {
    addIssue(ctx, 'missing_inference', 'must declare exactly one of model or harness');
  }
}

/**
 * Object shape extended with the `model` xor `harness` inference selector.
 * `required` forces exactly one at this level (agentDefaults, routing stages).
 */
export function withInference<T extends z.ZodRawShape>(shape: T, required: boolean) {
  return z
    .object({ ...shape, model: modelSchema.optional(), harness: harnessSchema.optional() })
    .strict()
    .superRefine((value, ctx) => refineInference(value, ctx, required));
}

export const inferenceSchema = withInference({}, false);
export const requiredInferenceSchema = withInference({}, true);

export const repositorySchema = z
  .object({
    owner: z.string().min(1),
    name: z.string().min(1),
    codeForge: z.enum(['github', 'gitlab', 'azure_devops']).optional(),
  })
  .strict();
