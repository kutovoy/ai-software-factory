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
  })
  .strict();

export type FactoryManifest = z.infer<typeof factorySchema>;
