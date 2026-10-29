/**
 * Secret resolution (ADR-023): definitions and integrations reference secrets by **name**;
 * the value is resolved from the process environment at call time and never returned by an
 * API projection or written to an event/log.
 */

export function resolveSecret(ref: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env[ref] ?? env[ref.toUpperCase()] ?? env[`SECRET_${ref.toUpperCase()}`];
}

export function isSecretConfigured(ref: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const value = resolveSecret(ref, env);
  return typeof value === 'string' && value.length > 0;
}

/**
 * Rejects anything that looks like a literal credential: a secret *reference* is a name,
 * never a value (spec: secret by reference).
 */
export function looksLikeSecretValue(value: string): boolean {
  return (
    /^(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{10,}$/.test(value) ||
    /^github_pat_[A-Za-z0-9_]{10,}$/.test(value) ||
    /^[A-Za-z0-9+/=]{40,}$/.test(value) ||
    /\s/.test(value)
  );
}
