import { describe, expect, it } from 'bun:test';
import type { z } from 'zod';
import {
  agentFrontmatterSchema,
  automationFrontmatterSchema,
  benchmarkTaskSchema,
  factorySchema,
  loadDefinition,
  loadOrThrow,
  mapZodIssues,
  scorerFrontmatterSchema,
} from '../src/index';
import { EXAMPLE, NEGATIVE_FIXTURES } from './helpers';
import { join } from 'node:path';

function codes(schema: z.ZodTypeAny, value: unknown): string[] {
  const result = schema.safeParse(value);
  if (result.success) return [];
  return mapZodIssues(result.error.issues, 'test.yaml').map((error) => error.code);
}

function baseFactory(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 'v1alpha1',
    name: 'fixture',
    repositories: [{ owner: 'acme', name: 'api' }],
    agentDefaults: { model: 'test-model' },
    gates: { review: 'human' },
    mergePolicy: 'human',
    ...overrides,
  };
}

describe('root manifest schema', () => {
  it('accepts a minimal manifest and applies defaults', () => {
    const result = factorySchema.safeParse(baseFactory());
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.secrets).toEqual([]);
  });

  it('rejects both model and harness', () => {
    const value = baseFactory({
      agentDefaults: { model: 'a', harness: { type: 'opencode', model: 'b' } },
    });
    expect(codes(factorySchema, value)).toContain('exclusive_inference');
  });

  it('rejects neither model nor harness at agentDefaults', () => {
    const value = baseFactory({ agentDefaults: { runner: 'local-docker' } });
    expect(codes(factorySchema, value)).toContain('missing_inference');
  });

  it('rejects empty repositories', () => {
    expect(codes(factorySchema, baseFactory({ repositories: [] }))).toContain(
      'invalid_repository',
    );
  });

  it('rejects a repository without owner', () => {
    const value = baseFactory({ repositories: [{ name: 'api' }] });
    expect(codes(factorySchema, value)).toContain('missing_field');
  });

  it('rejects invalid gate values', () => {
    expect(codes(factorySchema, baseFactory({ gates: { review: 'robot' } }))).toContain(
      'invalid_gate',
    );
  });

  it('accepts policy gates', () => {
    expect(codes(factorySchema, baseFactory({ gates: { deploy: 'policy:release-manager' } }))).toEqual(
      [],
    );
  });

  it('rejects unknown fields', () => {
    expect(codes(factorySchema, baseFactory({ bogus: true }))).toContain('unknown_field');
  });

  it('rejects managedSecret auth without secretName', () => {
    const value = baseFactory({
      agentDefaults: { harness: { type: 'opencode', model: 'm', auth: { source: 'managedSecret' } } },
    });
    expect(codes(factorySchema, value)).toContain('missing_field');
  });

  it('rejects an invalid merge policy', () => {
    expect(codes(factorySchema, baseFactory({ mergePolicy: 'yolo' }))).toContain('invalid_value');
  });
});

describe('resource schemas', () => {
  it('rejects an invalid sampling rate', () => {
    const scorer = {
      labels: [
        { value: 'ok', score: 1 },
        { value: 'bad', score: 0 },
      ],
      passingScore: 1,
      samplingRate: 150,
      judgeModel: 'judge',
    };
    expect(codes(scorerFrontmatterSchema, scorer)).toContain('invalid_sampling_rate');
  });

  it('rejects labels that cannot straddle passingScore', () => {
    const scorer = {
      labels: [{ value: 'ok', score: 1 }],
      passingScore: 1,
      judgeModel: 'judge',
    };
    expect(codes(scorerFrontmatterSchema, scorer)).toContain('invalid_scorer_labels');
  });

  it('rejects a benchmark task with a non-SHA startingRepoRef', () => {
    const task = {
      title: 't',
      prompt: 'p',
      successCriteria: 'c',
      startingRepoRefs: ['github.com:acme/api@abc123'],
    };
    expect(codes(benchmarkTaskSchema, task)).toContain('invalid_sha');
  });

  it('accepts a 40-char commit SHA', () => {
    const task = {
      title: 't',
      prompt: 'p',
      successCriteria: 'c',
      startingRepoRefs: ['github.com:acme/api@0123456789abcdef0123456789abcdef01234567'],
    };
    expect(codes(benchmarkTaskSchema, task)).toEqual([]);
  });

  it('rejects an invalid cron schedule', () => {
    const automation = {
      triggers: [{ provider: 'schedule', schedule: '* * *' }],
    };
    expect(codes(automationFrontmatterSchema, automation)).toContain('invalid_cron');
  });

  it('requires an event for non-schedule triggers', () => {
    const automation = { triggers: [{ provider: 'github' }] };
    expect(codes(automationFrontmatterSchema, automation)).toContain('missing_field');
  });

  it('rejects both model and harness on an agent', () => {
    const agent = { model: 'a', harness: { type: 'opencode', model: 'b' } };
    expect(codes(agentFrontmatterSchema, agent)).toContain('exclusive_inference');
  });
});

describe('loader', () => {
  it('loads the reference factory with every resource kind', () => {
    const definition = loadOrThrow(EXAMPLE);
    const identities = definition.resources.map((resource) => `${resource.kind}:${resource.name}`);
    expect(identities).toEqual(
      [
        'agent:foreman',
        'agent:implement',
        'agent:review',
        'agent:spec',
        'agent:triage',
        'agent:verify',
        'automation:intake',
        'automation:nightly',
        'benchmark:review',
        'benchmark-task:review/broken-doc-link',
        'benchmark-task:review/flaky-test',
        'routing:routing',
        'runner:local-docker',
        'scorer:scope',
        'skill:conventions',
      ].sort(),
    );
  });

  it('reports a missing schema version with the supported versions', () => {
    const { errors } = loadDefinition(join(NEGATIVE_FIXTURES, 'missing_field'));
    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe('missing_field');
    expect(errors[0].message).toContain('v1alpha1');
    expect(errors[0].pointer).toBe('/schemaVersion');
  });

  it('reports an unsupported schema version with a migration hint', () => {
    const { errors } = loadDefinition(join(NEGATIVE_FIXTURES, 'unsupported_schema_version'));
    expect(errors[0].code).toBe('unsupported_schema_version');
    expect(errors[0].message).toContain('supported versions: v1alpha1');
  });

  it('resolves secret references against the factory secret list', () => {
    const definition = loadOrThrow(EXAMPLE);
    const implement = definition.resources.find(
      (resource) => resource.kind === 'agent' && resource.name === 'implement',
    );
    expect(implement).toBeDefined();
    expect((implement?.doc as { harness: { auth: { secretName: string } } }).harness.auth.secretName).toBe(
      'OPENCODE_API_KEY',
    );
  });
});
