import { z } from 'zod';

/**
 * Deterministic guard hooks (roadmap item 4). Configuration is validated here; the checks
 * themselves are pure TypeScript with no shell, network or filesystem access.
 */

export interface GuardConfig {
  enabled?: boolean;
  secretScan?: boolean;
  protectedBranches?: string[];
  maxChangedFiles?: number;
  maxPatchBytes?: number;
  binaryFileLimit?: number;
}

export const guardConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    secretScan: z.boolean().optional(),
    protectedBranches: z.array(z.string().min(1)).optional(),
    maxChangedFiles: z.number().int().min(0).optional(),
    maxPatchBytes: z.number().int().min(0).optional(),
    binaryFileLimit: z.number().int().min(0).optional(),
  })
  .strict();

export interface GuardCheck {
  id: string;
  status: 'pass' | 'fail' | 'skipped';
  detail: string;
}

export interface GuardReport {
  passed: boolean;
  branch: string;
  changedFiles: number;
  patchBytes: number;
  checks: GuardCheck[];
}
