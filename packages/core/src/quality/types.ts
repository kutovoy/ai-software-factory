import { RISK_TIERS, type RiskTier } from '../governance/risk';

/**
 * Risk-tiered slop budgets and proof requirements (change
 * `add-anti-slop-budgets-and-proof`).
 *
 * Pure data + defaults only: no Node APIs, safe for the workflow sandbox. Resolution and
 * parsing live in `./slop`.
 */

/** The tiers a budget is declared for; aliases `RISK_TIERS` so the unions never drift. */
export const SLOP_BUDGET_TIERS = RISK_TIERS;
export type SlopBudgetTier = RiskTier;

/** Caps for one risk tier; a metric above its cap is a slop overage. */
export interface SlopBudget {
  maxDiffLines: number;
  maxChangedFiles: number;
  maxNewDependencies: number;
  maxDuplicationDeltaPercent: number;
  maxComplexityDelta: number;
}

export const DEFAULT_SLOP_BUDGETS: Record<RiskTier, SlopBudget> = {
  low: {
    maxDiffLines: 200,
    maxChangedFiles: 5,
    maxNewDependencies: 0,
    maxDuplicationDeltaPercent: 0.5,
    maxComplexityDelta: 5,
  },
  medium: {
    maxDiffLines: 400,
    maxChangedFiles: 10,
    maxNewDependencies: 1,
    maxDuplicationDeltaPercent: 1,
    maxComplexityDelta: 10,
  },
  high: {
    maxDiffLines: 800,
    maxChangedFiles: 20,
    maxNewDependencies: 2,
    maxDuplicationDeltaPercent: 2,
    maxComplexityDelta: 20,
  },
};

/** A partial per-tier override; missing fields and tiers inherit the defaults. */
export interface SlopBudgetConfig {
  low?: Partial<SlopBudget>;
  medium?: Partial<SlopBudget>;
  high?: Partial<SlopBudget>;
}

export const PROOF_KINDS = ['screenshot', 'video', 'html', 'curl', 'report', 'file'] as const;
export type ProofKind = (typeof PROOF_KINDS)[number];

/** The factory's optional `quality` block. */
export interface QualityConfig {
  slopBudget?: SlopBudgetConfig;
  proof?: {
    requireForUi?: boolean;
    kinds?: ProofKind[];
  };
}

/** Per-file counts derived from a unified diff. */
export interface PatchFileStats {
  path: string;
  additions: number;
  deletions: number;
}

export interface PatchMetrics {
  changedFiles: number;
  additions: number;
  deletions: number;
  diffLines: number;
  newDependencies: number;
  files: PatchFileStats[];
}

export interface SlopOverage {
  metric: keyof SlopBudget;
  actual: number;
  limit: number;
}

export interface SlopEvaluation {
  status: 'pass' | 'exceeded' | 'unknown';
  overages: SlopOverage[];
}

export const PLAN_DEPTHS = ['none', 'light', 'full'] as const;
export type PlanDepth = (typeof PLAN_DEPTHS)[number];

export const EXPECTED_PAIN_LEVELS = ['low', 'medium', 'high'] as const;
export type ExpectedPain = (typeof EXPECTED_PAIN_LEVELS)[number];
