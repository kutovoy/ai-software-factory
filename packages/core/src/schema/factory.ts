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
import { stageDeclarationSchema } from './stage';
import { AGENT_VERDICT_POLICIES } from '../gates/verdict';
import { guardConfigSchema } from '../guard/types';
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
     */
    budget: z
      .object({
        maxCostUsdPerRun: z.number().min(0).max(10_000).optional(),
        maxCostUsdPerStage: z.number().min(0).max(10_000).optional(),
        maxCostUsdPerFactory: z.number().min(0).max(1_000_000).optional(),
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
