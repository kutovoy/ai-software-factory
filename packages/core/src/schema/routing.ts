import { z } from 'zod';
import { STAGES, inferenceSchema, requiredInferenceSchema } from './common';

/**
 * `routing.yaml` collapses Warp's routers into one file: stage -> model|harness,
 * plus an optional default for stages without an explicit route.
 */
export const routingSchema = z
  .object({
    default: inferenceSchema.optional(),
    stages: z.record(z.enum(STAGES), requiredInferenceSchema),
    /**
     * Classifier-based routing (roadmap item 7). When enabled, the deterministic
     * classifier picks a tier from the task prompt + stage; the tier's inference wins
     * over the agent/default model. Disabled by default so existing definitions keep
     * their static routing.
     */
    classifier: z
      .object({
        enabled: z.boolean().default(false),
        cheap: requiredInferenceSchema,
        standard: requiredInferenceSchema,
        deep: requiredInferenceSchema,
      })
      .strict()
      .optional(),
  })
  .strict();

export type RoutingDef = z.infer<typeof routingSchema>;
