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
  })
  .strict();

export type RoutingDef = z.infer<typeof routingSchema>;
