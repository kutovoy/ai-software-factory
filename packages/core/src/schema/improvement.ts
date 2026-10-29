import { z } from 'zod';
import { addIssue } from './common';

/**
 * Improvement authority (Phase 5, ADR-020).
 *
 * `improvement` is a manifest field: changing the authority is a definition change, so it
 * travels through git/PR with an actor and a reason instead of being a runtime toggle.
 */
export const IMPROVEMENT_AUTHORITIES = [
  'propose_only',
  'auto_merge_on_benchmark',
  'canary',
] as const;
export type ImprovementAuthority = (typeof IMPROVEMENT_AUTHORITIES)[number];

export const DEFAULT_IMPROVEMENT_AUTHORITY: ImprovementAuthority = 'propose_only';
export const DEFAULT_IMPROVEMENT_MAX_PROBES = 3;
export const DEFAULT_IMPROVEMENT_OBSERVATION_WINDOW_HOURS = 24;

export const improvementSchema = z
  .object({
    authority: z.enum(IMPROVEMENT_AUTHORITIES).default(DEFAULT_IMPROVEMENT_AUTHORITY),
    /** Percentage of new work routed to the candidate while a canary is active. */
    canaryPercent: z.number().int().min(1).max(100).optional(),
    /** Allowed regression before an automatic rollback (fraction, 0..1). */
    rollbackThreshold: z.number().min(0).max(1).optional(),
    observationWindowHours: z
      .number()
      .int()
      .min(1)
      .max(720)
      .default(DEFAULT_IMPROVEMENT_OBSERVATION_WINDOW_HOURS),
    /** Maximum number of contrastive probes one improvement run may spend. */
    maxProbes: z.number().int().min(1).max(50).default(DEFAULT_IMPROVEMENT_MAX_PROBES),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.authority !== 'canary') return;
    if (value.canaryPercent === undefined) {
      addIssue(
        ctx,
        'missing_field',
        'improvement.authority "canary" requires improvement.canaryPercent (1-100)',
        ['canaryPercent'],
      );
    }
    if (value.rollbackThreshold === undefined) {
      addIssue(
        ctx,
        'missing_field',
        'improvement.authority "canary" requires improvement.rollbackThreshold (0..1)',
        ['rollbackThreshold'],
      );
    }
  });

export type ImprovementConfig = z.infer<typeof improvementSchema>;

/** The resolved authority for a manifest, including the default when the block is absent. */
export interface ResolvedImprovementConfig {
  authority: ImprovementAuthority;
  canaryPercent: number | null;
  rollbackThreshold: number | null;
  observationWindowHours: number;
  maxProbes: number;
  /** `declared` when factory.yaml carries the block, `default` otherwise. */
  source: 'declared' | 'default';
  /** True when the authority is `canary` but Phase 5b (rollout) is not available yet. */
  canaryAvailable: false;
}

export function resolveImprovement(
  improvement: ImprovementConfig | undefined,
): ResolvedImprovementConfig {
  return {
    authority: improvement?.authority ?? DEFAULT_IMPROVEMENT_AUTHORITY,
    canaryPercent: improvement?.canaryPercent ?? null,
    rollbackThreshold: improvement?.rollbackThreshold ?? null,
    observationWindowHours:
      improvement?.observationWindowHours ?? DEFAULT_IMPROVEMENT_OBSERVATION_WINDOW_HOURS,
    maxProbes: improvement?.maxProbes ?? DEFAULT_IMPROVEMENT_MAX_PROBES,
    source: improvement ? 'declared' : 'default',
    canaryAvailable: false,
  };
}
