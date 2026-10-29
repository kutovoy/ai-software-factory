import { z } from 'zod';

/** Path is identity: the skill name comes from `skills/<name>/SKILL.md`. */
export const skillFrontmatterSchema = z
  .object({
    description: z.string().min(1),
    appliesTo: z.array(z.string().min(1)).optional(),
  })
  .strict();

export type SkillDef = z.infer<typeof skillFrontmatterSchema>;
