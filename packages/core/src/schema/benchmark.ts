import { z } from 'zod';
import { addIssue, withInference } from './common';

/**
 * `host:owner/name@<40-char lowercase commit SHA>` — full SHAs only, never branches or tags.
 */
export const REPO_REF_RE = /^[a-z0-9.-]+\.[a-z]{2,}:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[0-9a-f]{40}$/;

export const repoRefSchema = z.string().superRefine((value, ctx) => {
  if (!REPO_REF_RE.test(value)) {
    addIssue(
      ctx,
      'invalid_sha',
      'startingRepoRefs entries must be host:owner/name@<40-char lowercase commit SHA>',
    );
  }
});

export const benchmarkTaskSchema = z
  .object({
    title: z.string().min(1),
    prompt: z.string().min(1),
    successCriteria: z.string().min(1),
    startingRepoRefs: z.array(repoRefSchema).min(1),
    sourceRunId: z.string().min(1).optional(),
    tags: z.array(z.string().min(1)).optional(),
    linearSeed: z.unknown().optional(),
  })
  .strict();

export const benchmarkConfigurationSchema = z
  .object({
    name: z.string().min(1),
    agents: z.array(withInference({ agent: z.string().min(1) }, false)).optional(),
  })
  .strict();

export const benchmarkSuiteSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().min(1).optional(),
    agent: z.string().min(1),
    configurations: z.array(benchmarkConfigurationSchema).min(1).max(6),
    tasks: z.array(z.string().min(1)),
  })
  .strict()
  .superRefine((value, ctx) => {
    const configurationNames = value.configurations.map((configuration) => configuration.name);
    if (new Set(configurationNames).size !== configurationNames.length) {
      addIssue(ctx, 'invalid_value', 'configuration names must be unique', ['configurations']);
    }
    if (new Set(value.tasks).size !== value.tasks.length) {
      addIssue(ctx, 'invalid_value', 'task slugs must be unique', ['tasks']);
    }
  });

export type BenchmarkSuite = z.infer<typeof benchmarkSuiteSchema>;
export type BenchmarkTask = z.infer<typeof benchmarkTaskSchema>;
