import type { MergePolicy } from '../schema/common';

/**
 * Risk-tiered autonomy (change `harden-factory-quality`).
 *
 * Risk tiers replace the coarse factory-wide "full autonomy" switch for routing human
 * attention: low-risk loops may run dark, medium/high plans require human gates. This
 * module is deliberately dependency-free so workflows can import it in the deterministic
 * sandbox.
 */

export const RISK_TIERS = ['low', 'medium', 'high'] as const;
export type RiskTier = (typeof RISK_TIERS)[number];

export const RISK_PLAN_APPROVAL_POLICIES = ['auto', 'human'] as const;
export type RiskPlanApproval = (typeof RISK_PLAN_APPROVAL_POLICIES)[number];

export const RISK_REVIEW_POLICIES = ['agent', 'human'] as const;
export type RiskReview = (typeof RISK_REVIEW_POLICIES)[number];

/** Merge policy for a risk tier; the same values as the factory `mergePolicy`. */
export type RiskMergePolicy = MergePolicy;

export interface RiskTierPolicy {
  planApproval: RiskPlanApproval;
  review: RiskReview;
  merge: RiskMergePolicy;
}

export interface RiskGovernance {
  defaultTier: RiskTier;
  tiers: Record<RiskTier, RiskTierPolicy>;
  highRiskPaths: string[];
}

export const DEFAULT_RISK_GOVERNANCE: RiskGovernance = {
  defaultTier: 'low',
  tiers: {
    low: { planApproval: 'auto', review: 'agent', merge: 'auto_on_green' },
    medium: { planApproval: 'human', review: 'agent', merge: 'auto_on_green' },
    high: { planApproval: 'human', review: 'human', merge: 'human' },
  },
  highRiskPaths: [],
};

export function isRiskTier(value: unknown): value is RiskTier {
  return typeof value === 'string' && (RISK_TIERS as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pickPlanApproval(value: unknown, fallback: RiskPlanApproval): RiskPlanApproval {
  return value === 'auto' || value === 'human' ? value : fallback;
}

function pickReview(value: unknown, fallback: RiskReview): RiskReview {
  return value === 'agent' || value === 'human' ? value : fallback;
}

function pickMerge(value: unknown, fallback: RiskMergePolicy): RiskMergePolicy {
  return value === 'human' ||
    value === 'auto_on_green' ||
    value === 'auto_after_n_approvals' ||
    value === 'disabled'
    ? value
    : fallback;
}

/**
 * Merges a parsed manifest `governance.risk` value (or any partial/unknown value) with
 * the defaults. Invalid fields fall back to the default policy instead of throwing.
 */
export function resolveRiskGovernance(value: unknown | null | undefined): RiskGovernance {
  const source = isRecord(value) ? value : {};
  const defaultTier = isRiskTier(source.defaultTier)
    ? source.defaultTier
    : DEFAULT_RISK_GOVERNANCE.defaultTier;

  const tiersSource = isRecord(source.tiers) ? source.tiers : {};
  const tiers = {} as Record<RiskTier, RiskTierPolicy>;
  for (const tier of RISK_TIERS) {
    const fallback = DEFAULT_RISK_GOVERNANCE.tiers[tier];
    const raw = isRecord(tiersSource[tier]) ? tiersSource[tier] : {};
    tiers[tier] = {
      planApproval: pickPlanApproval(raw.planApproval, fallback.planApproval),
      review: pickReview(raw.review, fallback.review),
      merge: pickMerge(raw.merge, fallback.merge),
    };
  }

  const highRiskPaths = Array.isArray(source.highRiskPaths)
    ? source.highRiskPaths
        .filter(
          (pattern): pattern is string =>
            typeof pattern === 'string' && pattern.trim().length > 0,
        )
        .slice(0, 50)
    : [];

  return { defaultTier, tiers, highRiskPaths };
}

/** The policy for a tier; absent governance falls back to the shipped defaults. */
export function riskPolicyFor(
  governance: RiskGovernance | null | undefined,
  tier: RiskTier,
): RiskTierPolicy {
  const resolved = governance ? resolveRiskGovernance(governance) : DEFAULT_RISK_GOVERNANCE;
  return resolved.tiers[tier] ?? DEFAULT_RISK_GOVERNANCE.tiers[tier];
}

/** `low` < `medium` < `high`. */
export function riskTierRank(tier: RiskTier): number {
  switch (tier) {
    case 'low':
      return 0;
    case 'medium':
      return 1;
    case 'high':
      return 2;
  }
}

function normalizePath(value: string): string {
  return value.trim().replaceAll('\\', '/').replace(/^\.\//, '');
}

const globCache = new Map<string, RegExp>();
const REGEX_SPECIAL = new Set('\\^$.*+?()[]{}|');

/**
 * Converts a path glob to an anchored, case-insensitive regexp. `**` crosses directory
 * separators (a trailing `**` plus slash also matches zero directories), `*` stays inside
 * one segment and `?` matches one non-separator character.
 */
function globToRegExp(pattern: string): RegExp {
  const cached = globCache.get(pattern);
  if (cached) return cached;

  const normalized = normalizePath(pattern);
  let source = '';
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    if (char === '*') {
      if (normalized[index + 1] === '*') {
        if (normalized[index + 2] === '/') {
          source += '(?:.*/)?';
          index += 2;
        } else {
          source += '.*';
          index += 1;
        }
      } else {
        source += '[^/]*';
      }
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += REGEX_SPECIAL.has(char) ? `\\${char}` : char;
    }
  }

  const regexp = new RegExp(`^${source}$`, 'i');
  globCache.set(pattern, regexp);
  return regexp;
}

/** True when `path` matches a high-risk glob; matching is case-insensitive. */
export function pathMatchesHighRisk(pattern: string, path: string): boolean {
  if (typeof pattern !== 'string' || typeof path !== 'string') return false;
  const normalizedPattern = normalizePath(pattern);
  const normalizedPath = normalizePath(path);
  if (normalizedPattern.length === 0 || normalizedPath.length === 0) return false;
  return globToRegExp(normalizedPattern).test(normalizedPath);
}

export interface ClassifyRiskInput {
  declaredTier?: RiskTier;
  paths?: string[];
  changeSize?: number;
  goal?: string;
  governance?: RiskGovernance | null;
}

export interface RiskClassification {
  tier: RiskTier;
  reasons: string[];
}

const HIGH_RISK_GOAL_PATTERNS: { label: string; pattern: RegExp }[] = [
  { label: 'auth/authentication', pattern: /\bauth(?:entication|orization)?\b/i },
  { label: 'billing', pattern: /\bbilling\b/i },
  { label: 'payment', pattern: /\bpayments?\b/i },
  { label: 'migration', pattern: /\bmigrations?\b/i },
  { label: 'public api', pattern: /\bpublic\s+api\b/i },
  { label: 'security', pattern: /\bsecurity\b/i },
];

function maxTier(left: RiskTier, right: RiskTier): RiskTier {
  return riskTierRank(left) >= riskTierRank(right) ? left : right;
}

/**
 * Derives a risk tier from the explicit declaration, governance defaults, high-risk path
 * globs, change size and goal wording. The highest signal wins; every signal is recorded
 * as a human-readable reason so a plan gate can explain the decision.
 */
export function classifyRisk(input: ClassifyRiskInput): RiskClassification {
  const governance = input.governance ? resolveRiskGovernance(input.governance) : null;
  const defaultTier = governance?.defaultTier ?? DEFAULT_RISK_GOVERNANCE.defaultTier;

  let tier: RiskTier = 'low';
  const reasons: string[] = [];
  const addReason = (reason: string): void => {
    if (!reasons.includes(reason)) reasons.push(reason);
  };

  if (isRiskTier(input.declaredTier)) {
    tier = maxTier(tier, input.declaredTier);
    addReason(`declared risk tier is "${input.declaredTier}"`);
  }

  if (riskTierRank(defaultTier) > riskTierRank(tier)) {
    tier = defaultTier;
    addReason(`governance default risk tier is "${defaultTier}"`);
  }

  const highRiskPaths = governance?.highRiskPaths ?? DEFAULT_RISK_GOVERNANCE.highRiskPaths;
  const paths = Array.isArray(input.paths)
    ? input.paths.filter((path): path is string => typeof path === 'string')
    : [];
  for (const path of paths) {
    const pattern = highRiskPaths.find((candidate) => pathMatchesHighRisk(candidate, path));
    if (pattern) {
      tier = 'high';
      addReason(`path "${path}" matches high-risk pattern "${pattern}"`);
    }
  }

  const changeSize = input.changeSize;
  if (typeof changeSize === 'number' && Number.isFinite(changeSize) && changeSize >= 0) {
    if (changeSize >= 400) {
      tier = 'high';
      addReason(`change size ${changeSize} meets the high-risk threshold (400)`);
    } else if (changeSize >= 150) {
      tier = maxTier(tier, 'medium');
      addReason(`change size ${changeSize} meets the medium-risk threshold (150)`);
    }
  }

  const goal = typeof input.goal === 'string' ? input.goal : '';
  for (const { label, pattern } of HIGH_RISK_GOAL_PATTERNS) {
    if (pattern.test(goal)) {
      tier = 'high';
      addReason(`goal mentions "${label}"`);
    }
  }

  const nonEmptyLines = goal
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0).length;
  if (nonEmptyLines > 4) {
    tier = maxTier(tier, 'medium');
    addReason(`goal has ${nonEmptyLines} non-empty lines (more than 4)`);
  }

  if (reasons.length === 0) {
    addReason(`no elevated risk signals; using tier "${tier}"`);
  }

  return { tier, reasons };
}
