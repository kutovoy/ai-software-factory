import { z } from 'zod';

/**
 * Optional `stages` block in `factory.yaml`. The ordered list is the loop's stage graph:
 * each entry needs the previous one unless it declares `needs` explicitly (an empty
 * `needs: []` makes a stage start in parallel).
 *
 * Names are validated by the compiler, not by the schema, so an unknown stage is reported
 * as `invalid_stage_graph` naming the offending node (not a generic `invalid_value`).
 */
export const stageDeclarationSchema = z
  .object({
    name: z.string().min(1).max(60),
    needs: z.array(z.string().min(1).max(60)).optional(),
    /** Agent that runs this stage; omitted for non-agent stages such as `ship`. */
    agent: z.string().min(1).max(120).optional(),
    /** Independent reviewers to fan out to (review stage); defaults to 2 for `review`. */
    reviewers: z.number().int().min(1).max(9).optional(),
  })
  .strict();

export type StageDeclarationDef = z.infer<typeof stageDeclarationSchema>;
