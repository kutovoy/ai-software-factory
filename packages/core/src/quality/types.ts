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

/**
 * Factory-level attention budget (change `add-review-capacity-and-compounding`).
 *
 * The factory can produce more changes than a team can review; these caps make review
 * capacity an explicit, measurable backpressure signal. Every field is optional so old
 * factories validate with the shipped defaults.
 */
export interface ReviewCapacityConfig {
  /** Maximum pending review gates across the factory. */
  maxOpenGates?: number;
  /** Maximum unread diff lines across pending review gates. */
  maxUnreadDiffLines?: number;
  /** Maximum age (hours) of the oldest pending review gate. */
  maxGateAgeHours?: number;
  /** Maximum review effort (hours) the team can spend per week. */
  maxReviewHoursPerWeek?: number;
}

/** Shipped review-capacity defaults. */
export const DEFAULT_REVIEW_CAPACITY = {
  maxOpenGates: 20,
  maxUnreadDiffLines: 4000,
  maxGateAgeHours: 48,
  maxReviewHoursPerWeek: 20,
} as const;

/** A capacity config with every cap resolved to a number. */
export interface ResolvedReviewCapacity {
  maxOpenGates: number;
  maxUnreadDiffLines: number;
  maxGateAgeHours: number;
  maxReviewHoursPerWeek: number;
}

/** Current factory review pressure against the resolved caps. */
export interface ReviewCapacityStatus {
  saturated: boolean;
  openGates: number;
  unreadDiffLines: number;
  oldestGateHours: number;
  /** Human-readable reasons, e.g. `open gates 21 > 20`; empty when within bounds. */
  reasons: string[];
}

/**
 * Honest aggregate comprehension proxies. They never claim a human read a specific diff;
 * they report how much shipped work has not been reviewed by a human.
 */
export interface ComprehensionMetrics {
  unreadDiffLines: number;
  itemsWithoutHumanReview: number;
  modulesWithoutHumanTouch: number;
  reviewCoveragePercent: number;
}

/** The factory's optional `quality` block. */
export interface QualityConfig {
  slopBudget?: SlopBudgetConfig;
  proof?: {
    requireForUi?: boolean;
    kinds?: ProofKind[];
  };
  /** Review-capacity caps (change `add-review-capacity-and-compounding`). */
  reviewCapacity?: ReviewCapacityConfig;
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
