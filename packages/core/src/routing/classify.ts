import { resolveModelRef } from '../model/ref';
import type { RiskTier } from '../governance/risk';
import type { HarnessType } from '../schema/common';
import type { RoutingDef } from '../schema/routing';

/**
 * Deterministic model routing (roadmap item 7).
 *
 * A small, explainable classifier maps the task prompt + stage to a cost tier. It is not
 * an LLM: the same input always yields the same tier, so routing is reproducible in tests
 * and audits. When `routing.classifier.enabled` is true, the chosen tier's inference wins
 * over the agent/default model; otherwise the existing stage/default routing is used.
 *
 * Risk-aware routing (change `add-risk-aware-routing-and-standards`): a `high` risk tier
 * always selects the `deep` tier when the classifier block exists, regardless of the score
 * or `enabled`. Without a classifier block the stage/default route is kept and the reason
 * records `risk=high`, so the choice stays honest about what it could not upgrade.
 */

export type RoutingTier = 'cheap' | 'standard' | 'deep';

export interface RoutingChoice {
  tier: RoutingTier | null;
  /** Resolved model value, or null when the selected inference is a harness without a model. */
  model: string | null;
  harness: { type: HarnessType; model: string } | null;
  score: number;
  reason: string;
  source: 'classifier' | 'stage' | 'default' | 'none';
}

const DEEP_KEYWORDS =
  /\b(security|migration|architecture|refactor|performance|concurrency|database|distributed|auth|encryption)\b/i;
const CHEAP_KEYWORDS = /\b(readme|typo|rename|small|simple|docs?|comment)\b/i;

const STAGE_SCORE: Record<string, number> = {
  triage: 1,
  spec: 3,
  plan: 3,
  implement: 5,
  review: 7,
  pr_review: 7,
  verify: 7,
  ship: 2,
  deploy: 3,
};

export function scoreTask(prompt: string, stage: string): { score: number; reason: string } {
  const base = STAGE_SCORE[stage] ?? 4;
  const length = Math.min(prompt.length / 500, 4);
  const deep = DEEP_KEYWORDS.test(prompt) ? 3 : 0;
  const cheap = CHEAP_KEYWORDS.test(prompt) ? -2 : 0;
  const score = Math.max(0, Math.min(10, base + length + deep + cheap));
  return {
    score,
    reason: `stage=${stage} base=${base} length=${length.toFixed(1)} deep=${deep} cheap=${cheap}`,
  };
}

export function tierForScore(score: number): RoutingTier {
  if (score <= 2) return 'cheap';
  if (score >= 7) return 'deep';
  return 'standard';
}

function resolved(
  inference: { model?: string; harness?: { type: HarnessType; model: string } } | undefined,
  env: NodeJS.ProcessEnv,
): { model: string | null; harness: { type: HarnessType; model: string } | null } {
  if (!inference) return { model: null, harness: null };
  if (inference.harness) {
    const model = resolveModelRef(inference.harness.model, env).value;
    return {
      model,
      harness: model === null ? null : { type: inference.harness.type, model },
    };
  }
  return { model: inference.model ? resolveModelRef(inference.model, env).value : null, harness: null };
}

/**
 * Selects the inference for a stage. Precedence:
 *  1. high risk tier + classifier block (forced `deep`);
 *  2. enabled classifier tier;
 *  3. explicit stage route in `routing.yaml`;
 *  4. routing default;
 *  5. none (the caller keeps the agent/default model).
 */
export function chooseRouting(args: {
  routing: RoutingDef | null | undefined;
  prompt: string;
  stage: string;
  env?: NodeJS.ProcessEnv;
  /** Work-item risk tier; `high` forces the deep tier when a classifier exists. */
  riskTier?: RiskTier;
}): RoutingChoice {
  const env = args.env ?? process.env;
  const routing = args.routing;
  const risk = args.riskTier;
  const riskSuffix = risk === 'high' ? ' (risk=high)' : '';
  if (!routing) {
    return {
      tier: null,
      model: null,
      harness: null,
      score: 0,
      reason: `no routing.yaml${riskSuffix}`,
      source: 'none',
    };
  }

  const scored = scoreTask(args.prompt, args.stage);

  if (risk === 'high' && routing.classifier) {
    const inference = routing.classifier.deep;
    const value = resolved(inference, env);
    return {
      tier: 'deep',
      ...value,
      score: scored.score,
      reason: `deep: risk=high; ${scored.reason}`,
      source: 'classifier',
    };
  }

  if (routing.classifier?.enabled) {
    const tier = tierForScore(scored.score);
    const inference = routing.classifier[tier];
    const value = resolved(inference, env);
    return {
      tier,
      ...value,
      score: scored.score,
      reason: `${tier}: ${scored.reason}${riskSuffix}`,
      source: 'classifier',
    };
  }

  const stageInference = routing.stages[args.stage as keyof RoutingDef['stages']];
  if (stageInference) {
    const value = resolved(stageInference, env);
    return {
      tier: null,
      ...value,
      score: 0,
      reason: `explicit stage route for ${args.stage}${riskSuffix}`,
      source: 'stage',
    };
  }

  if (routing.default) {
    const value = resolved(routing.default, env);
    return {
      tier: null,
      ...value,
      score: 0,
      reason: `routing default${riskSuffix}`,
      source: 'default',
    };
  }

  return {
    tier: null,
    model: null,
    harness: null,
    score: 0,
    reason: `routing has no route${riskSuffix}`,
    source: 'none',
  };
}
