import { z } from 'zod';
import {
  addIssue,
  gatesSchema,
  isValidCron,
  secretNameSchema,
  withInference,
} from './common';

export const TRIGGER_PROVIDERS = [
  'github',
  'gitlab',
  'azure_devops',
  'linear',
  'jira',
  'slack',
  'teams',
  'webhook',
  'schedule',
  'factory',
] as const;

export const triggerSchema = z
  .object({
    provider: z.enum(TRIGGER_PROVIDERS),
    event: z.string().min(1).optional(),
    filter: z.record(z.string(), z.unknown()).optional(),
    schedule: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.provider === 'schedule') {
      if (!value.schedule) {
        addIssue(ctx, 'missing_field', 'schedule triggers require a cron schedule', ['schedule']);
      } else if (!isValidCron(value.schedule)) {
        addIssue(ctx, 'invalid_cron', `invalid cron expression "${value.schedule}"`, ['schedule']);
      }
      if (value.event !== undefined && value.event !== 'cron_fired') {
        addIssue(ctx, 'invalid_value', 'schedule triggers use event "cron_fired"', ['event']);
      }
      return;
    }
    if (!value.event) {
      addIssue(ctx, 'missing_field', `provider "${value.provider}" requires an event`, ['event']);
    }
  });

export const automationFrontmatterSchema = withInference(
  {
    displayName: z.string().min(1).optional(),
    enabled: z.boolean().default(true),
    agent: z.string().min(1).optional(),
    triggers: z.array(triggerSchema).min(1),
    runner: z.string().min(1).optional(),
    secrets: z.array(secretNameSchema).optional(),
    mcpServers: z.array(z.string().min(1)).optional(),
    idleTimeoutMinutes: z.number().int().min(1).max(60).optional(),
    gates: gatesSchema.optional(),
  },
  false,
);

export type AutomationDef = z.infer<typeof automationFrontmatterSchema>;
