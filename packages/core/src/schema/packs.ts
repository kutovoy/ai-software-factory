import { z } from 'zod';

/** Placeholder for shared-pack imports (Phase 5+); shape is intentionally loose. */
export const packsLockSchema = z
  .object({
    packs: z.array(
      z
        .object({
          name: z.string().min(1),
          version: z.string().min(1).optional(),
          commit: z.string().min(1).optional(),
          hash: z.string().min(1).optional(),
        })
        .strict(),
    ),
  })
  .strict();

export type PacksLock = z.infer<typeof packsLockSchema>;
