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
import { stageDeclarationSchema } from './stage';

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
    mergePolicy: z.enum(MERGE_POLICIES),
    /**
     * Ordered stage graph for the factory loop. Optional: when omitted the graph is
     * derived from the agents' `role` fields (see `stageDeclarationsFromDefinition`).
     */
    stages: z.array(stageDeclarationSchema).min(1).optional(),
    secrets: z.array(secretNameSchema).default([]),
    mcpServers: z.record(z.string(), z.unknown()).optional(),
    integrations: z.array(z.enum(INTEGRATIONS)).optional(),
    selfImprovement: selfImprovementSchema.optional(),
  })
  .strict();

export type FactoryManifest = z.infer<typeof factorySchema>;
