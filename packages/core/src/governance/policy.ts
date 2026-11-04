/**
 * Governance policy (roadmap item 10).
 *
 * Deterministic, fail-closed action policy for unattended runs. It complements the autonomy
 * kill switch: the kill switch stops dispatch; this decides whether a specific tool action is
 * allowed, denied or needs a human.
 */

export type GovernanceAutonomyLevel = 'observe' | 'assist' | 'auto' | 'full';
export type GovernanceDecision = 'allow' | 'deny' | 'require_human';

export interface GovernanceConfig {
  autonomyLevel?: GovernanceAutonomyLevel;
  allowedModels?: string[];
  denyActions?: string[];
  requireHumanActions?: string[];
  audit?: { export?: 'jsonl' | 'otel'; otlpEndpoint?: string };
}

export class ModelNotAllowedError extends Error {
  readonly code = 'model_not_allowed' as const;
  readonly model: string;
  readonly allowed: string[];

  constructor(model: string, allowed: string[]) {
    super(`model "${model}" is not in the factory's governance allowlist (${allowed.join(', ')})`);
    this.name = 'ModelNotAllowedError';
    this.model = model;
    this.allowed = allowed;
  }
}

function globMatches(pattern: string, value: string): boolean {
  if (pattern === '*') return true;
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*');
  return new RegExp(`^${escaped}$`, 'i').test(value);
}

export function evaluateActionPolicy(
  config: GovernanceConfig | null | undefined,
  action: string,
): { decision: GovernanceDecision; reason: string } {
  if (!config) return { decision: 'allow', reason: 'no governance policy' };

  for (const pattern of config.denyActions ?? []) {
    if (globMatches(pattern, action)) {
      return { decision: 'deny', reason: `action "${action}" matches deny policy "${pattern}"` };
    }
  }

  for (const pattern of config.requireHumanActions ?? []) {
    if (globMatches(pattern, action)) {
      return {
        decision: 'require_human',
        reason: `action "${action}" matches human-approval policy "${pattern}"`,
      };
    }
  }

  // `observe` and `assist` do not allow unattended mutations. A factory stage is unattended,
  // so the safe default is to require a human; the workflow records the refusal.
  if (config.autonomyLevel === 'observe' || config.autonomyLevel === 'assist') {
    return {
      decision: 'require_human',
      reason: `autonomyLevel "${config.autonomyLevel}" does not allow unattended action "${action}"`,
    };
  }

  return { decision: 'allow', reason: `autonomyLevel "${config.autonomyLevel ?? 'auto'}" allows "${action}"` };
}

export function assertModelAllowed(
  config: GovernanceConfig | null | undefined,
  model: string | null,
): void {
  const allowed = config?.allowedModels;
  if (!allowed || allowed.length === 0 || model === null) return;
  if (!allowed.some((pattern) => globMatches(pattern, model))) {
    throw new ModelNotAllowedError(model, allowed);
  }
}
