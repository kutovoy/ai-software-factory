import { z } from 'zod';

export const runnerSchema = z
  .object({
    description: z.string().min(1).optional(),
    setupCommands: z.array(z.string()).optional(),
    instanceShape: z
      .object({
        vcpus: z.number().int().min(1),
        memoryGb: z.number().min(1),
      })
      .strict()
      .optional(),
    platform: z
      .object({
        os: z.enum(['linux', 'macos', 'windows']),
        arch: z.enum(['x86_64', 'arm64']),
        linux: z.object({ dockerImage: z.string().min(1) }).strict().optional(),
      })
      .strict()
      .optional(),
    failureSessionRetentionMinutes: z.number().int().min(1).max(60).optional(),
  })
  .strict();

export type RunnerDef = z.infer<typeof runnerSchema>;
