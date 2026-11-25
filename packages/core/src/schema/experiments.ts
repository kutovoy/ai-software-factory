import { z } from 'zod';
import { secretNameSchema } from './common';

/**
 * Optional experiment provider configuration (change
 * `add-review-capacity-and-compounding`).
 *
 * P1 is metadata only: the factory declares which provider owns its flags and which secret
 * (by name) holds the project key. No provider is called and no key is ever written here.
 */

export const EXPERIMENT_PROVIDERS = [
  'posthog',
  'statsig',
  'launchdarkly',
  'generic',
] as const;
export type ExperimentProvider = (typeof EXPERIMENT_PROVIDERS)[number];

export interface ExperimentsConfig {
  provider: ExperimentProvider;
  /** Secret *name* holding the project key; resolved at run time, never inlined. */
  projectKeySecret?: string;
  /** Prefix applied to every flag the factory creates. Defaults to `factory_`. */
  flagPrefix?: string;
  /** Whether an experiment must be cleaned up after its rollout window. */
  requireCleanup?: boolean;
}

export const DEFAULT_EXPERIMENT_FLAG_PREFIX = 'factory_';

export const experimentsConfigSchema = z
  .object({
    provider: z.enum(EXPERIMENT_PROVIDERS),
    projectKeySecret: secretNameSchema.optional(),
    flagPrefix: z
      .string()
      .min(1)
      .max(60)
      .regex(/^[A-Za-z0-9_.-]+$/, 'flagPrefix must be letters, digits, ".", "_" or "-"')
      .default(DEFAULT_EXPERIMENT_FLAG_PREFIX),
    requireCleanup: z.boolean().default(true),
  })
  .strict();

export type ExperimentsConfigParsed = z.infer<typeof experimentsConfigSchema>;
