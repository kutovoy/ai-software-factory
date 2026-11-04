import { z } from 'zod';
import { VALIDATION_EVIDENCE_SOURCES, VALIDATION_TIERS } from './types';

/**
 * Zod mirror of the workflow-safe validation types. Defaults are deliberately forgiving:
 * `enabled` is on, `enforce` is off, so adding the block never breaks an existing loop.
 */

export const validationCheckSchema = z
  .object({
    id: z.string().min(1).max(120),
    title: z.string().min(1).max(200),
    tier: z.enum(VALIDATION_TIERS),
    required: z.boolean().default(true),
    evidence: z.enum(['command', 'artifact', 'forge-check', 'manual']),
    command: z.string().min(1).optional(),
    expected: z.string().min(1).optional(),
  })
  .strict();

export const validationConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    enforce: z.boolean().default(false),
    tiers: z.array(z.enum(VALIDATION_TIERS)).optional(),
    checks: z.array(validationCheckSchema).optional(),
  })
  .strict();

export const validationContractSchema = z
  .object({
    version: z.literal('v1alpha1'),
    workItemId: z.string().min(1),
    factory: z.string().min(1),
    definitionCommit: z.string().min(7),
    createdAt: z.string().min(1),
    enforce: z.boolean().default(false),
    checks: z.array(validationCheckSchema).min(1),
    risks: z.array(z.string()).default([]),
    source: z.enum(['factory', 'inferred', 'work-item']),
  })
  .strict();

export const validationEvidenceSchema = z
  .object({
    checkId: z.string().min(1),
    status: z.enum(['pass', 'fail']),
    source: z.enum(VALIDATION_EVIDENCE_SOURCES),
    detail: z.string().optional(),
    at: z.string().optional(),
  })
  .strict();
