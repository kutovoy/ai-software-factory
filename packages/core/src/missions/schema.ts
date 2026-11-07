import { z } from 'zod';
import { VALIDATION_TIERS } from '../validation/types';
import { WORK_ITEM_TYPES } from '../work-items/types';
import {
  MISSION_FEATURE_ID_RE,
  MISSION_ID_RE,
  MISSION_MILESTONE_ID_RE,
  MISSION_STATUSES,
} from './types';

/**
 * Zod mirrors for mission plans and API bodies. The plan schema is deliberately strict:
 * a mission must have at least one milestone, at least one feature, and a validation
 * contract with at least one assertion before any work item starts.
 */

export const missionBudgetSchema = z
  .object({
    maxCostUsd: z.number().min(0).max(1_000_000).optional(),
    maxRuns: z.number().int().min(1).max(10_000).optional(),
    maxWallClockHours: z.number().min(0.1).max(24 * 365).optional(),
  })
  .strict();

export const missionValidationAssertionSchema = z
  .object({
    id: z.string().min(1).max(120),
    title: z.string().min(1).max(200),
    assertion: z.string().min(1).max(4000),
    tier: z.enum(VALIDATION_TIERS),
    required: z.boolean().default(true),
    tool: z.string().min(1).max(120),
    evidence: z.string().min(1).max(500),
    command: z.string().min(1).max(2000).optional(),
    expected: z.string().min(1).max(1000).optional(),
  })
  .strict();

export const missionValidationContractSchema = z
  .object({
    version: z.literal('v1alpha1'),
    missionId: z.string().regex(MISSION_ID_RE),
    factory: z.string().min(1),
    definitionCommit: z.string().min(7),
    createdAt: z.string().min(1),
    enforce: z.boolean().default(true),
    assertions: z.array(missionValidationAssertionSchema).min(1),
    risks: z.array(z.string()).default([]),
    source: z.enum(['orchestrator', 'human', 'factory']),
  })
  .strict();

export const missionFeaturePlanSchema = z
  .object({
    id: z.string().regex(MISSION_FEATURE_ID_RE),
    title: z.string().min(1).max(200),
    description: z.string().min(1).max(8000),
    order: z.number().int().min(0),
    dependsOn: z.array(z.string().regex(MISSION_FEATURE_ID_RE)).default([]),
    acceptanceCheckIds: z.array(z.string().min(1).max(120)).min(1),
    workItemType: z.enum(WORK_ITEM_TYPES).optional(),
  })
  .strict();

export const missionMilestonePlanSchema = z
  .object({
    id: z.string().regex(MISSION_MILESTONE_ID_RE),
    title: z.string().min(1).max(200),
    description: z.string().min(1).max(8000),
    order: z.number().int().min(0),
    features: z.array(missionFeaturePlanSchema).min(1),
  })
  .strict();

export const missionPlanSchema = z
  .object({
    version: z.literal('v1alpha1'),
    missionId: z.string().regex(MISSION_ID_RE),
    factory: z.string().min(1),
    definitionCommit: z.string().min(7),
    title: z.string().min(1).max(200),
    goal: z.string().min(1).max(20_000),
    createdAt: z.string().min(1),
    validationContract: missionValidationContractSchema,
    milestones: z.array(missionMilestonePlanSchema).min(1),
    risks: z.array(z.string()).default([]),
    assumptions: z.array(z.string()).default([]),
  })
  .strict();

export const createMissionBodySchema = z
  .object({
    title: z.string().min(1).max(200),
    goal: z.string().min(1).max(20_000),
    budget: missionBudgetSchema.optional(),
    /** When false the planner may be skipped and a supplied plan is used. */
    plan: missionPlanSchema.optional(),
  })
  .strict();

export const missionPlanDecisionBodySchema = z
  .object({
    decision: z.enum(['approve', 'reject', 'request_changes']),
    actor: z.string().min(1).max(120),
    reason: z.string().max(2000).optional(),
    feedback: z.string().max(8000).optional(),
  })
  .strict();

export const missionControlBodySchema = z
  .object({
    actor: z.string().min(1).max(120),
    reason: z.string().max(2000).optional(),
  })
  .strict();

export const missionRetryFeatureBodySchema = z
  .object({
    actor: z.string().min(1).max(120),
    reason: z.string().max(2000).optional(),
  })
  .strict();

export const missionStatusSchema = z.enum(MISSION_STATUSES);
