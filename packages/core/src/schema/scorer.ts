import { z } from 'zod';
import { addIssue, secretNameSchema } from './common';

export const scorerLabelSchema = z
  .object({
    value: z.string().min(1),
    description: z.string().min(1).optional(),
    score: z.number().min(0).max(1),
  })
  .strict();

export const scorerFrontmatterSchema = z
  .object({
    description: z.string().min(1).optional(),
    output: z.literal('classification').default('classification'),
    labels: z.array(scorerLabelSchema).min(1).max(20),
    passingScore: z.number().min(0).max(1),
    samplingRate: z
      .number()
      .superRefine((value, ctx) => {
        if (!Number.isInteger(value) || value < 0 || value > 100) {
          addIssue(
            ctx,
            'invalid_sampling_rate',
            'samplingRate must be an integer between 0 and 100',
          );
        }
      })
      .default(25),
    judgeModel: z.string().min(1),
    agents: z.array(z.string().min(1)).optional(),
    selfImprovement: z.boolean().default(false),
    runner: z.string().min(1).optional(),
    secrets: z.array(secretNameSchema).optional(),
    mcpServers: z.array(z.string().min(1)).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const scores = value.labels.map((label) => label.score);
    if (!scores.some((score) => score >= value.passingScore)) {
      addIssue(
        ctx,
        'invalid_scorer_labels',
        `at least one label must score >= passingScore (${value.passingScore})`,
        ['labels'],
      );
    }
    if (!scores.some((score) => score < value.passingScore)) {
      addIssue(
        ctx,
        'invalid_scorer_labels',
        `at least one label must score below passingScore (${value.passingScore})`,
        ['labels'],
      );
    }
  });

export type ScorerDef = z.infer<typeof scorerFrontmatterSchema>;
