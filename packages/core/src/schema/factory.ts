import { z } from 'zod';
import {
  INTEGRATIONS,
  MERGE_POLICIES,
  SCHEMA_VERSION,
  codedString,
  gatesSchema,
  repositorySchema,
  secretNameSchema,
  withInference,
} from './common';
import { improvementSchema } from './improvement';
import { mcpSchema } from './mcp';
import { experimentsConfigSchema } from './experiments';
import { stageDeclarationSchema } from './stage';
import { AGENT_VERDICT_POLICIES } from '../gates/verdict';
import { guardConfigSchema } from '../guard/types';
import { DEFAULT_RISK_GOVERNANCE, RISK_TIERS, type RiskTierPolicy } from '../governance/risk';
import {
  DEFAULT_REVIEW_CAPACITY,
  DEFAULT_SLOP_BUDGETS,
  PROOF_KINDS,
  type SlopBudget,
} from '../quality/types';
import { validationConfigSchema } from '../validation/schema';
import { newUlid } from '../work-items/id';

/**
 * Stable factory identity (change `add-factory-identity`): `fac_` + a 26-character Crockford
 * base32 ULID. Committed once in `factory.yaml`; it survives a database rebuild and is the
 * only factory identifier a URL may contain.
 */
export const FACTORY_ID_RE = /^fac_[0-9A-HJKMNP-TV-Z]{26}$/;

/** A fresh `fac_<ulid>`; the migration script uses it for factories that predate `id`. */
export function newFactoryId(nowMs: number = Date.now()): string {
  return `fac_${newUlid(nowMs)}`;
}

export const agentDefaultsSchema = withInference(
  {
    runner: z.string().min(1).optional(),
    secrets: z.array(secretNameSchema).optional(),
    mcpServers: z.array(z.string().min(1)).optional(),
    idleTimeoutMinutes: z.number().int().min(1).max(60).optional(),
  },
  true,
);

export const selfImprovementSchema = z
  .object({
    enabled: z.boolean().default(true),
    failedRunThreshold: z.number().int().min(1).max(50).default(3),
    reviewerType: z.enum(['humans', 'none']).default('humans'),
    requireBenchmarkWin: z.boolean().default(false),
  })
  .strict();

/**
 * Per-tier risk policy (change `harden-factory-quality`). Missing fields and missing tier
 * keys inherit `DEFAULT_RISK_GOVERNANCE`, so a factory can override just one action.
 */
function riskTierPolicySchema(defaults: RiskTierPolicy) {
  return z
    .object({
      planApproval: z.enum(['auto', 'human']).default(defaults.planApproval),
      review: z.enum(['agent', 'human']).default(defaults.review),
      merge: z.enum(MERGE_POLICIES).default(defaults.merge),
    })
    .strict()
    .default(defaults);
}

export const riskGovernanceSchema = z
  .object({
    defaultTier: z.enum(RISK_TIERS).default(DEFAULT_RISK_GOVERNANCE.defaultTier),
    tiers: z
      .object({
        low: riskTierPolicySchema(DEFAULT_RISK_GOVERNANCE.tiers.low),
        medium: riskTierPolicySchema(DEFAULT_RISK_GOVERNANCE.tiers.medium),
        high: riskTierPolicySchema(DEFAULT_RISK_GOVERNANCE.tiers.high),
      })
      .strict()
      .default(DEFAULT_RISK_GOVERNANCE.tiers),
    highRiskPaths: z.array(z.string().min(1)).max(50).default([]),
  })
  .strict();

/**
 * One risk tier's slop caps (change `add-anti-slop-budgets-and-proof`). Every field is
 * defaulted from the tier's shipped budget, so a partial tier inherits the rest.
 */
export function slopBudgetSchema(defaults: SlopBudget = DEFAULT_SLOP_BUDGETS.low) {
  return z
    .object({
      maxDiffLines: z.number().int().min(0).max(100_000).default(defaults.maxDiffLines),
      maxChangedFiles: z.number().int().min(0).max(10_000).default(defaults.maxChangedFiles),
      maxNewDependencies: z.number().int().min(0).max(100).default(defaults.maxNewDependencies),
      maxDuplicationDeltaPercent: z
        .number()
        .min(0)
        .max(100)
        .default(defaults.maxDuplicationDeltaPercent),
      maxComplexityDelta: z.number().min(0).max(1000).default(defaults.maxComplexityDelta),
    })
    .strict();
}

/** Per-tier budget overrides; missing tiers and fields inherit the defaults. */
export const slopBudgetConfigSchema = z
  .object({
    low: slopBudgetSchema(DEFAULT_SLOP_BUDGETS.low).default(DEFAULT_SLOP_BUDGETS.low),
    medium: slopBudgetSchema(DEFAULT_SLOP_BUDGETS.medium).default(DEFAULT_SLOP_BUDGETS.medium),
    high: slopBudgetSchema(DEFAULT_SLOP_BUDGETS.high).default(DEFAULT_SLOP_BUDGETS.high),
  })
  .strict();

/** Proof requirements for UI/behavioral changes; off unless opted in. */
export const qualityProofSchema = z
  .object({
    requireForUi: z.boolean().default(false),
    kinds: z.array(z.enum(PROOF_KINDS)).default([...PROOF_KINDS]),
  })
  .strict();

/**
 * Factory-level review-capacity caps (change `add-review-capacity-and-compounding`).
 * Every field is defaulted, so a partial block inherits the shipped defaults.
 */
export const reviewCapacitySchema = z
  .object({
    maxOpenGates: z
      .number()
      .int()
      .min(1)
      .max(10_000)
      .default(DEFAULT_REVIEW_CAPACITY.maxOpenGates),
    maxUnreadDiffLines: z
      .number()
      .int()
      .min(0)
      .max(10_000_000)
      .default(DEFAULT_REVIEW_CAPACITY.maxUnreadDiffLines),
    maxGateAgeHours: z
      .number()
      .min(0.1)
      .max(24 * 365)
      .default(DEFAULT_REVIEW_CAPACITY.maxGateAgeHours),
    maxReviewHoursPerWeek: z
      .number()
      .min(0.1)
      .max(168)
      .default(DEFAULT_REVIEW_CAPACITY.maxReviewHoursPerWeek),
  })
  .strict();

/** The optional `quality` block; absent means defaults everywhere. */
export const qualityConfigSchema = z
  .object({
    slopBudget: slopBudgetConfigSchema.optional(),
    proof: qualityProofSchema.optional(),
    reviewCapacity: reviewCapacitySchema.optional(),
  })
  .strict();

export const factorySchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    /**
     * Optional in the schema so old fixtures keep validating; the runtime loader requires
     * it (`factory_id_missing`, change `add-factory-identity`).
     */
    id: codedString(FACTORY_ID_RE, 'invalid_value', 'factory id must be fac_<26-char ulid>').optional(),
    name: codedString(
      /^[a-z0-9][a-z0-9._-]*$/,
      'invalid_value',
      'factory name must be lowercase letters, digits, ".", "_" or "-"',
    ),
    alias: z.string().min(1).max(60).optional(),
    description: z.string().min(1).optional(),
    repositories: z.array(repositorySchema).superRefine((value, ctx) => {
      if (value.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'at least one repository is required',
          params: { errorCode: 'invalid_repository' },
        });
      }
    }),
    agentDefaults: agentDefaultsSchema,
    gates: gatesSchema,
    /**
     * What an agent gate does when the stage emits no verdict (change `add-agent-verdicts`):
     * `advisory` approves (pre-verdict behaviour), `required` requests changes.
     */
    agentVerdict: z.enum(AGENT_VERDICT_POLICIES).default('advisory'),
    mergePolicy: z.enum(MERGE_POLICIES),
    /**
     * Ordered stage graph for the factory loop. Optional: when omitted the graph is
     * derived from the agents' `role` fields (see `stageDeclarationsFromDefinition`).
     */
    stages: z.array(stageDeclarationSchema).min(1).optional(),
    secrets: z.array(secretNameSchema).default([]),
    /**
     * MCP servers (spec `mcp-integration`): transport + credential *references*.
     * `mcpServers` below is the legacy shorthand (`{name: {command}}`); it is still
     * accepted so existing definitions keep validating, but new definitions use `mcp`.
     */
    mcp: mcpSchema.optional(),
    /** @deprecated Legacy server map; prefer `mcp.servers`. */
    mcpServers: z.record(z.string(), z.unknown()).optional(),
    integrations: z.array(z.enum(INTEGRATIONS)).optional(),
    selfImprovement: selfImprovementSchema.optional(),
    /**
     * Phase 5 (ADR-020): how an improvement proposal may land. Optional; the resolved
     * authority defaults to `propose_only` (see `resolveImprovement`).
     */
    improvement: improvementSchema.optional(),
    /** Validation contract defaults (roadmap item 1); `enforce` is off unless opted in. */
    validation: validationConfigSchema.optional(),
    /**
     * Risk-tiered slop budgets and proof requirements (change
     * `add-anti-slop-budgets-and-proof`). Optional: old factories keep the shipped defaults.
     */
    quality: qualityConfigSchema.optional(),
    /**
     * Optional experiment provider metadata (change
     * `add-review-capacity-and-compounding`). Metadata only in P1; secrets are referenced
     * by name and never inlined.
     */
    experiments: experimentsConfigSchema.optional(),
    /** Agent readiness (roadmap item 2); advisory unless `enforceAutonomy` is true. */
    readiness: z
      .object({
        enforceAutonomy: z.boolean().default(false),
        thresholds: z
          .object({
            ready: z.number().int().min(0).max(100).default(80),
            warn: z.number().int().min(0).max(100).default(60),
          })
          .strict()
          .superRefine((value, ctx) => {
            if (value.warn > value.ready) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: 'readiness.thresholds.warn must be <= thresholds.ready',
                params: { errorCode: 'invalid_value' },
              });
            }
          }),
      })
      .strict()
      .optional(),
    /** Deterministic pre-PR guard hooks (roadmap item 4). */
    guard: guardConfigSchema.optional(),
    /**
     * Spend caps (roadmap item 7). `maxCostUsdPerRun` applies to every stage run,
     * `maxCostUsdPerStage` narrows it for a specific stage, and `maxCostUsdPerFactory`
     * refuses new work once the factory's recorded spend reaches the cap.
     *
     * Quotas (change `add-retention-quotas-promotion`): `maxCostUsdPerDay` and
     * `maxCostUsdPerMonth` cap spend inside the current calendar day/month window, and
     * `maxConcurrentRuns` bounds pending/running runs for the factory. Every cap is
     * optional; an absent cap is reported as absent, never as zero.
     */
    budget: z
      .object({
        maxCostUsdPerRun: z.number().min(0).max(10_000).optional(),
        maxCostUsdPerStage: z.number().min(0).max(10_000).optional(),
        maxCostUsdPerFactory: z.number().min(0).max(1_000_000).optional(),
        maxCostUsdPerDay: z.number().min(0).max(100_000).optional(),
        maxCostUsdPerMonth: z.number().min(0).max(1_000_000).optional(),
        maxConcurrentRuns: z.number().int().min(1).max(100).optional(),
      })
      .strict()
      .optional(),
    /**
     * Governance (roadmap item 10): autonomy level, model allowlist and per-action policy.
     * The autonomy kill switch remains separate; this block describes what the factory may
     * do when it is running unattended.
     */
    governance: z
      .object({
        autonomyLevel: z.enum(['observe', 'assist', 'auto', 'full']).default('auto'),
        /**
         * Risk-tiered autonomy: per-tier plan/review/merge policy and high-risk path globs.
         * Optional so old factories keep validating with the low-risk defaults.
         */
        risk: riskGovernanceSchema.optional(),
        allowedModels: z.array(z.string().min(1)).max(50).optional(),
        /** Action globs that are always denied (e.g. `bash`, `git.push`). */
        denyActions: z.array(z.string().min(1)).max(50).optional(),
        /** Action globs that require a human; unattended runs deny them and record it. */
        requireHumanActions: z.array(z.string().min(1)).max(50).optional(),
        audit: z
          .object({
            export: z.enum(['jsonl', 'otel']).default('jsonl'),
            otlpEndpoint: z.string().min(1).optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type FactoryManifest = z.infer<typeof factorySchema>;
