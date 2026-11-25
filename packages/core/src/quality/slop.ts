import { pathMatchesHighRisk, type RiskTier } from '../governance/risk';
import { resolveReviewCapacity } from './capacity';
import { resolveQualityStandards } from './standards';
import {
  DEFAULT_SLOP_BUDGETS,
  PROOF_KINDS,
  SLOP_BUDGET_TIERS,
  type ExpectedPain,
  type PatchFileStats,
  type PatchMetrics,
  type PlanDepth,
  type ProofKind,
  type QualityConfig,
  type QualityStandards,
  type ResolvedReviewCapacity,
  type SlopBudget,
  type SlopBudgetConfig,
  type SlopEvaluation,
  type SlopOverage,
} from './types';

/**
 * Deterministic slop measurement and budget evaluation (change
 * `add-anti-slop-budgets-and-proof`). No model, no shell, no Node APIs: a patch string and
 * a budget go in, facts come out.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function pickNumber(value: unknown, fallback: number, integer: boolean): number {
  if (!isFiniteNumber(value) || value < 0) return fallback;
  return integer ? Math.floor(value) : value;
}

/** True for a value the proof contract accepts as an artifact kind. */
export function isProofKind(value: unknown): value is ProofKind {
  return typeof value === 'string' && (PROOF_KINDS as readonly string[]).includes(value);
}

function mergeBudget(value: unknown, defaults: SlopBudget): SlopBudget {
  const source = isRecord(value) ? value : {};
  return {
    maxDiffLines: pickNumber(source.maxDiffLines, defaults.maxDiffLines, true),
    maxChangedFiles: pickNumber(source.maxChangedFiles, defaults.maxChangedFiles, true),
    maxNewDependencies: pickNumber(source.maxNewDependencies, defaults.maxNewDependencies, true),
    maxDuplicationDeltaPercent: pickNumber(
      source.maxDuplicationDeltaPercent,
      defaults.maxDuplicationDeltaPercent,
      false,
    ),
    maxComplexityDelta: pickNumber(source.maxComplexityDelta, defaults.maxComplexityDelta, false),
  };
}

/**
 * Merges a partial/unknown budget config with the shipped defaults. Accepts both the
 * `{ low, medium, high }` shape and a full `QualityConfig` (`{ slopBudget: {...} }`).
 */
export function resolveSlopBudgets(
  config?: QualityConfig | SlopBudgetConfig | null,
): Record<RiskTier, SlopBudget> {
  const source = isRecord(config) ? config : {};
  const tiers = isRecord(source.slopBudget) ? source.slopBudget : source;
  const resolved = {} as Record<RiskTier, SlopBudget>;
  for (const tier of SLOP_BUDGET_TIERS) {
    resolved[tier] = mergeBudget(tiers[tier], DEFAULT_SLOP_BUDGETS[tier]);
  }
  return resolved;
}

export interface ResolvedQualityConfig {
  slopBudget: Record<RiskTier, SlopBudget>;
  proof: { requireForUi: boolean; kinds: ProofKind[] };
  /** Factory-level review-capacity caps (change `add-review-capacity-and-compounding`). */
  reviewCapacity: ResolvedReviewCapacity;
  /** Public-API/schema caps (change `add-risk-aware-routing-and-standards`). */
  standards: QualityStandards;
}

/**
 * Resolves the optional `quality` block. Missing/partial values inherit defaults: budgets
 * come from `DEFAULT_SLOP_BUDGETS`, `requireForUi` is off, every proof kind is accepted,
 * review capacity comes from `DEFAULT_REVIEW_CAPACITY` and standards from
 * `DEFAULT_QUALITY_STANDARDS`.
 */
export function resolveQualityConfig(value: unknown | null | undefined): ResolvedQualityConfig {
  const source = isRecord(value) ? value : {};
  const proofSource = isRecord(source.proof) ? source.proof : {};
  const requireForUi = typeof proofSource.requireForUi === 'boolean' ? proofSource.requireForUi : false;
  const rawKinds = Array.isArray(proofSource.kinds) ? proofSource.kinds : [];
  const kinds: ProofKind[] = [];
  for (const kind of rawKinds) {
    if (isProofKind(kind) && !kinds.includes(kind)) kinds.push(kind);
  }
  return {
    slopBudget: resolveSlopBudgets(source),
    proof: { requireForUi, kinds: kinds.length > 0 ? kinds : [...PROOF_KINDS] },
    reviewCapacity: resolveReviewCapacity(source.reviewCapacity),
    standards: resolveQualityStandards(source.standards),
  };
}

function emptyMetrics(): PatchMetrics {
  return { changedFiles: 0, additions: 0, deletions: 0, diffLines: 0, newDependencies: 0, files: [] };
}

function headerPath(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed === '/dev/null') return null;
  return trimmed.replace(/^[ab]\//, '');
}

/** `true` opens a dependency block, `false` closes/leaves it, `null` is unrelated. */
function dependencySection(content: string): boolean | null {
  const trimmed = content.trim();
  if (/^"(dependencies|devDependencies)"\s*:\s*\{/.test(trimmed)) return true;
  // Any other object-opening key is a new top-level section, so the dependency block ended.
  if (/^\s*"[^"]+"\s*:\s*\{/.test(content)) return false;
  if (trimmed.startsWith('}')) return false;
  return null;
}

/** A `"name": "version"` line inside a dependency block (never `"name": {...}`). */
function isDependencyEntry(content: string): boolean {
  const match = /^\s*"([^"]+)"\s*:\s*"[^"]*"/.exec(content);
  if (!match) return false;
  const name = match[1];
  return name !== 'dependencies' && name !== 'devDependencies';
}

/**
 * Parses a unified diff into deterministic metrics. Counts added/deleted lines (headers
 * excluded), changed files and new dependencies declared in a `package.json` diff hunk.
 * Missing or non-diff input yields zeroes; the parser never throws.
 */
export function parsePatchMetrics(patch: string): PatchMetrics {
  if (typeof patch !== 'string' || patch.trim().length === 0) return emptyMetrics();

  try {
    const files = new Map<string, PatchFileStats>();
    let current: string | null = null;
    let additions = 0;
    let deletions = 0;
    let newDependencies = 0;
    let inDependencies = false;

    const touch = (path: string): string => {
      if (!files.has(path)) files.set(path, { path, additions: 0, deletions: 0 });
      return path;
    };

    for (const line of patch.split(/\r?\n/)) {
      if (line.startsWith('diff --git ')) {
        const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
        current = match ? touch(match[2]) : null;
        inDependencies = false;
        continue;
      }
      if (line.startsWith('+++ ') || line.startsWith('--- ')) {
        const path = headerPath(line.slice(4));
        if (path !== null && current === null) current = touch(path);
        continue;
      }
      if (line.startsWith('@@')) continue;

      const marker = line[0];
      if (marker !== '+' && marker !== '-' && marker !== ' ') continue;
      const content = line.slice(1);
      const stats = current !== null ? files.get(current) : undefined;
      const isPackageJson = current !== null && current.split('/').pop() === 'package.json';

      if (isPackageJson) {
        const section = dependencySection(content);
        if (section !== null) inDependencies = section;
        if (marker === '+' && inDependencies && isDependencyEntry(content)) newDependencies += 1;
      }

      if (marker === '+') {
        additions += 1;
        if (stats) stats.additions += 1;
      } else if (marker === '-') {
        deletions += 1;
        if (stats) stats.deletions += 1;
      }
    }

    return {
      changedFiles: files.size,
      additions,
      deletions,
      diffLines: additions + deletions,
      newDependencies,
      files: [...files.values()],
    };
  } catch {
    return emptyMetrics();
  }
}

/** Files matching at least one high-risk glob, in input order, without duplicates. */
export function highRiskPathsTouched(files: string[], patterns: string[]): string[] {
  const fileList = Array.isArray(files)
    ? files.filter((file): file is string => typeof file === 'string')
    : [];
  const patternList = Array.isArray(patterns)
    ? patterns.filter((pattern): pattern is string => typeof pattern === 'string')
    : [];
  const touched: string[] = [];
  for (const file of fileList) {
    if (touched.includes(file)) continue;
    if (patternList.some((pattern) => pathMatchesHighRisk(pattern, file))) touched.push(file);
  }
  return touched;
}

/**
 * Compares measured metrics with a tier budget. Duplication/complexity are optional: an
 * unknown value is never treated as zero and never fails on its own. When no metric is
 * known the result is `unknown`.
 */
export function evaluateSlopBudget(
  metrics: Pick<
    PatchMetrics,
    'changedFiles' | 'additions' | 'deletions' | 'diffLines' | 'newDependencies'
  > & { duplicationDeltaPercent?: number | null; complexityDelta?: number | null },
  budget: SlopBudget,
): SlopEvaluation {
  const overages: SlopOverage[] = [];
  let known = 0;

  const check = (metric: keyof SlopBudget, actual: number | null, limit: number): void => {
    if (actual === null) return;
    known += 1;
    if (actual > limit) overages.push({ metric, actual, limit });
  };

  const diffLines =
    isFiniteNumber(metrics.additions) && isFiniteNumber(metrics.deletions)
      ? metrics.additions + metrics.deletions
      : null;

  check('maxDiffLines', diffLines, budget.maxDiffLines);
  check('maxChangedFiles', isFiniteNumber(metrics.changedFiles) ? metrics.changedFiles : null, budget.maxChangedFiles);
  check(
    'maxNewDependencies',
    isFiniteNumber(metrics.newDependencies) ? metrics.newDependencies : null,
    budget.maxNewDependencies,
  );
  check(
    'maxDuplicationDeltaPercent',
    isFiniteNumber(metrics.duplicationDeltaPercent) ? metrics.duplicationDeltaPercent : null,
    budget.maxDuplicationDeltaPercent,
  );
  check(
    'maxComplexityDelta',
    isFiniteNumber(metrics.complexityDelta) ? metrics.complexityDelta : null,
    budget.maxComplexityDelta,
  );

  if (overages.length > 0) return { status: 'exceeded', overages };
  if (known === 0) return { status: 'unknown', overages: [] };
  return { status: 'pass', overages: [] };
}

/**
 * Right-sizes planning. Deterministic and conservative: anything risky gets `full`,
 * medium signals get `light`, and a low-risk reversible change with no measured size may
 * skip planning (`none`). High signals always win over medium ones.
 */
export function planDepthFor(input: {
  riskTier: RiskTier;
  expectedPain?: ExpectedPain;
  changeSize?: number;
  reversible?: boolean;
  touchesDataOrApi?: boolean;
}): PlanDepth {
  if (input.riskTier === 'high' || input.touchesDataOrApi === true || input.expectedPain === 'high') {
    return 'full';
  }

  const changeSize = isFiniteNumber(input.changeSize) ? input.changeSize : 0;
  if (input.riskTier === 'medium' || input.expectedPain === 'medium' || changeSize >= 150) {
    return 'light';
  }

  // Low risk: skip only when nothing was measured and the change can be rolled back.
  if (input.reversible === true && (input.changeSize === undefined || changeSize === 0)) {
    return 'none';
  }
  return 'light';
}
