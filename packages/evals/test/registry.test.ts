import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadDefinition } from '@factory/core';
import {
  ScorerRegistryError,
  loadScorerRegistry,
  rubricHashFor,
  registryEntry,
} from '../src/registry';

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..');
const EXAMPLE = join(REPO_ROOT, 'factories/example');
const NEGATIVE = join(REPO_ROOT, 'packages/core/test/fixtures/negative');

function writeFixture(root: string, scorerBody: string, scorerFrontmatter: string): void {
  mkdirSync(join(root, 'scorers/checks'), { recursive: true });
  mkdirSync(join(root, 'runners'), { recursive: true });
  writeFileSync(
    join(root, 'factory.yaml'),
    [
      'schemaVersion: v1alpha1',
      'name: fixture',
      'repositories:',
      '  - owner: acme',
      '    name: api',
      'agentDefaults:',
      '  harness:',
      '    type: opencode',
      '    model: openai/gpt-5',
      '  runner: local-docker',
      'gates: {}',
      'mergePolicy: human',
    ].join('\n'),
  );
  writeFileSync(
    join(root, 'runners/local-docker.yaml'),
    ['description: Fixture runner.', 'platform:', '  os: linux', '  arch: x86_64'].join('\n'),
  );
  writeFileSync(join(root, 'scorers/checks/scorer.md'), `${scorerFrontmatter}\n\n${scorerBody}\n`);
}

describe('scorer registry', () => {
  test('the example factory registers a judge scorer with a content hash', () => {
    const { definition, errors } = loadDefinition(EXAMPLE);
    expect(errors).toEqual([]);
    const registry = loadScorerRegistry(definition!);
    expect(registry).toHaveLength(1);
    const scorer = registry[0]!;
    expect(scorer.name).toBe('scope');
    expect(scorer.scorerClass).toBe('judge');
    expect(scorer.checks).toEqual([]);
    expect(scorer.judgeModel).toBe('anthropic/claude-haiku-4-5');
    expect(scorer.passingScore).toBe(1);
    expect(scorer.samplingRate).toBe(25);
    expect(scorer.labels.map((label) => label.value)).toEqual([
      'compliant',
      'partial',
      'non_compliant',
    ]);
    expect(scorer.rubricHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test('a checks block infers a deterministic scorer', () => {
    const root = mkdtempSync(join(tmpdir(), 'factory-evals-registry-'));
    writeFixture(
      root,
      'Run the checks.\n\nchecks:\n  - tests\n  - build\n  - lint',
      [
        '---',
        'description: Did the checks pass?',
        'judgeModel: stub',
        'labels:',
        '  - value: pass',
        '    score: 1',
        '  - value: fail',
        '    score: 0',
        'passingScore: 1',
        'samplingRate: 100',
        '---',
      ].join('\n'),
    );
    const { definition, errors } = loadDefinition(root);
    expect(errors).toEqual([]);
    const scorer = loadScorerRegistry(definition!)[0]!;
    expect(scorer.scorerClass).toBe('deterministic');
    expect(scorer.checks).toEqual(['tests', 'build', 'lint']);
  });

  test('rubricHash changes when the body or labels change', () => {
    const labels = [
      { value: 'good', score: 1 },
      { value: 'bad', score: 0 },
    ];
    const base = rubricHashFor('grade the run', labels);
    expect(rubricHashFor('grade the run', labels)).toBe(base);
    expect(rubricHashFor('grade the run differently', labels)).not.toBe(base);
    expect(rubricHashFor('grade the run', [{ value: 'good', score: 1 }, { value: 'bad', score: 0.2 }])).not.toBe(base);
  });

  test('an invalid label set is rejected by the registry', () => {
    expect(() =>
      registryEntry({
        name: 'broken',
        path: 'scorers/broken/scorer.md',
        body: 'rubric',
        doc: {
          labels: [
            { value: 'pass', score: 1 },
            { value: 'also_pass', score: 0.9 },
          ],
          passingScore: 0.8,
          samplingRate: 10,
          judgeModel: 'stub',
          selfImprovement: false,
          output: 'classification',
        },
      }),
    ).toThrow(ScorerRegistryError);
  });

  test('unsupported deterministic checks are rejected', () => {
    expect(() =>
      registryEntry({
        name: 'broken',
        path: 'scorers/broken/scorer.md',
        body: 'checks:\n  - deploy',
        doc: {
          labels: [
            { value: 'pass', score: 1 },
            { value: 'fail', score: 0 },
          ],
          passingScore: 1,
          samplingRate: 10,
          judgeModel: 'stub',
          selfImprovement: false,
          output: 'classification',
        },
      }),
    ).toThrow(ScorerRegistryError);
  });

  test('the core loader rejects an invalid scorer definition', () => {
    const { definition, errors } = loadDefinition(join(NEGATIVE, 'invalid_scorer_labels'));
    expect(definition).toBeNull();
    expect(errors.some((error) => error.code === 'invalid_scorer_labels')).toBe(true);
  });
});
