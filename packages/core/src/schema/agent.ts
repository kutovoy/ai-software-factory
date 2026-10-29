import { z } from 'zod';
import { secretNameSchema, withInference } from './common';

export const AGENT_ROLES = [
  'foreman',
  'triage',
  'spec',
  'implement',
  'review',
  'verify',
  'custom',
] as const;

export const agentFrontmatterSchema = withInference(
  {
    description: z.string().min(1).optional(),
    role: z.enum(AGENT_ROLES).optional(),
    runner: z.string().min(1).optional(),
    tools: z
      .object({
        allow: z.array(z.string().min(1)).optional(),
        deny: z.array(z.string().min(1)).optional(),
      })
      .strict()
      .optional(),
    secrets: z.array(secretNameSchema).optional(),
    mcpServers: z.array(z.string().min(1)).optional(),
    spawnableBy: z.array(z.string().min(1)).optional(),
    idleTimeoutMinutes: z.number().int().min(1).max(60).optional(),
  },
  false,
);

export type AgentDef = z.infer<typeof agentFrontmatterSchema>;
