import { RunnerError } from './errors';
import type { SecretRef } from './protocol';

/**
 * Secret boundary (ADR: inference credentials never enter the sandbox).
 *
 * Two independent gates, both must pass:
 *   1. the name must be on the execution allowlist (`allowedSecrets`);
 *   2. the name must not match an inference-credential pattern, even if someone
 *      allowlisted it by mistake.
 *
 * Values are resolved outside the sandbox by name (env by default) and are never written
 * to the event log — `scrubSecrets` redacts them from captured stdout/stderr.
 */

/** Execution secrets the factory commonly grants. Extend per deployment. */
export const DEFAULT_EXECUTION_ALLOWLIST: readonly string[] = [
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'GITLAB_TOKEN',
  'NPM_TOKEN',
  'SLACK_BOT_TOKEN',
  'SLACK_WEBHOOK_URL',
  'SENTRY_AUTH_TOKEN',
  'LINEAR_API_KEY',
];

/** Anything that smells like an inference credential. Never injectable. */
export const INFERENCE_CREDENTIAL_PATTERNS: readonly RegExp[] = [
  /^OPENAI_/i,
  /^ANTHROPIC_/i,
  /^AZURE_OPENAI/i,
  /^AZURE_.*_KEY$/i,
  /^GOOGLE_(AI|API|GEMINI)/i,
  /^GEMINI_/i,
  /^VERTEX_/i,
  /^MISTRAL_/i,
  /^GROQ_/i,
  /^OPENROUTER_/i,
  /^LITELLM_/i,
  /^TOGETHER_/i,
  /^DEEPSEEK_/i,
  /^XAI_/i,
  /^COHERE_/i,
  /^PERPLEXITY_/i,
  /^FACTORY_MODEL$/i,
  /^FACTORY_.*(KEY|TOKEN)$/i,
  /(_API_KEY|_APIKEY)$/i,
  /^MODEL_API/i,
];

export function isInferenceCredential(name: string): boolean {
  return INFERENCE_CREDENTIAL_PATTERNS.some((pattern) => pattern.test(name));
}

export interface ResolvedSecret {
  name: string;
  value: string;
}

export interface ResolveSecretOptions {
  allowedSecrets?: readonly string[];
  /** Defaults to `process.env[name]`. Values must come from outside the sandbox. */
  resolve?: (name: string) => string | undefined | Promise<string | undefined>;
}

export async function resolveSecrets(
  refs: readonly SecretRef[],
  options: ResolveSecretOptions = {},
): Promise<ResolvedSecret[]> {
  const allowed = options.allowedSecrets ?? DEFAULT_EXECUTION_ALLOWLIST;
  const resolve = options.resolve ?? ((name: string) => process.env[name]);
  const resolved: ResolvedSecret[] = [];

  for (const ref of refs) {
    const name = ref.name;
    if (typeof name !== 'string' || name.trim() === '') {
      throw new RunnerError('invalid_spec', 'secret reference must have a name');
    }

    if (isInferenceCredential(name)) {
      throw new RunnerError(
        'inference_credential_forbidden',
        `inference credential "${name}" may not be injected into a runner`,
        { name },
      );
    }

    if (!allowed.includes(name)) {
      throw new RunnerError('secret_not_granted', `secret "${name}" is not on the execution allowlist`, {
        name,
        allowedSecrets: [...allowed],
      });
    }

    const value = await resolve(name);
    if (value === undefined || value === '') {
      throw new RunnerError('secret_not_granted', `secret "${name}" is not resolvable`, { name });
    }

    resolved.push({ name, value });
  }

  return resolved;
}

/** Replaces every secret value in captured output with `***`. */
export function scrubSecrets(text: string, values: readonly string[]): string {
  let result = text;
  for (const value of values) {
    if (value.length === 0) continue;
    result = result.split(value).join('***');
  }
  return result;
}

/**
 * Strips inference credentials from a host environment before handing it to a
 * process-based runner. The local backend runs on the dev host, so it must not inherit
 * the model keys the API/worker use.
 */
export function sanitizeHostEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (isInferenceCredential(name)) continue;
    result[name] = value;
  }
  return result;
}

/** Rejects a runner env block that tries to smuggle an inference credential inside. */
export function assertNoInferenceEnv(env?: Record<string, string>): void {
  for (const name of Object.keys(env ?? {})) {
    if (isInferenceCredential(name)) {
      throw new RunnerError(
        'inference_credential_forbidden',
        `inference credential "${name}" may not be injected into a runner`,
        { name },
      );
    }
  }
}
