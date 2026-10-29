import { describe, expect, test } from 'bun:test';
import { evaluateDeterministic } from '../src/deterministic';
import { registryEntry } from '../src/registry';
import type { RunEvidence, ScorerRegistryEntry } from '../src/types';

function deterministicScorer(checks: string[] = ['tests', 'build', 'lint']): ScorerRegistryEntry {
  return registryEntry({
    name: 'checks',
    path: 'scorers/checks/scorer.md',
    body: `Run the checks.\n\nchecks:\n${checks.map((check) => `  - ${check}`).join('\n')}`,
    doc: {
      labels: [
        { value: 'pass', score: 1, description: 'all checks passed' },
        { value: 'fail', score: 0, description: 'a check failed' },
      ],
      passingScore: 1,
      samplingRate: 100,
      judgeModel: 'stub',
      selfImprovement: false,
      output: 'classification',
    },
  });
}

function evidence(overrides: Partial<RunEvidence> = {}): RunEvidence {
  return { artifacts: [], artifactContents: {}, toolCalls: [], ...overrides };
}

describe('deterministic scoring', () => {
  test('a checks.json artifact with every check green passes', () => {
    const outcome = evaluateDeterministic(
      deterministicScorer(),
      evidence({
        artifacts: [{ path: 'artifacts/checks.json', kind: 'log' }],
        artifactContents: {
          'artifacts/checks.json': JSON.stringify({ tests: true, build: true, lint: { ok: true } }),
        },
      }),
    );
    expect(outcome.status).toBe('ok');
    expect(outcome.passing).toBe(true);
    expect(outcome.label).toBe('pass');
    expect(outcome.score).toBe(1);
    expect(outcome.evidenceRefs).toContain('artifact:checks.json');
  });

  test('a failing check yields the lowest label', () => {
    const outcome = evaluateDeterministic(
      deterministicScorer(),
      evidence({
        artifactContents: {
          'checks.json': JSON.stringify({ tests: true, build: { ok: false }, lint: true }),
        },
      }),
    );
    expect(outcome.status).toBe('ok');
    expect(outcome.passing).toBe(false);
    expect(outcome.label).toBe('fail');
    expect(outcome.score).toBe(0);
    expect(outcome.rationale).toContain('build: fail');
  });

  test('events supply evidence when there is no checks artifact', () => {
    const outcome = evaluateDeterministic(
      deterministicScorer(),
      evidence({
        toolCalls: [
          { name: 'bash', command: 'bun test', ok: true, seq: 4 },
          { name: 'bash', command: 'bun run build', ok: true, seq: 6 },
          { name: 'bash', command: 'ls -la', ok: true, seq: 8 },
          { name: 'bash', command: 'bun run lint', ok: false, seq: 10 },
        ],
      }),
    );
    expect(outcome.status).toBe('ok');
    expect(outcome.passing).toBe(false);
    expect(outcome.evidenceRefs).toEqual(['event:4', 'event:6', 'event:10']);
  });

  test('a missing required artifact is an error, never a guessed pass', () => {
    const outcome = evaluateDeterministic(
      deterministicScorer(['tests', 'build']),
      evidence({ toolCalls: [{ name: 'bash', command: 'ls -la', ok: true, seq: 2 }] }),
    );
    expect(outcome.status).toBe('error');
    expect(outcome.errorCode).toBe('missing_artifact');
    expect(outcome.label).toBeNull();
    expect(outcome.score).toBeNull();
    expect(outcome.passing).toBe(false);
    expect(outcome.missing).toEqual(['tests', 'build']);
    expect(outcome.rationale).toContain('missing_artifact');
  });
});
