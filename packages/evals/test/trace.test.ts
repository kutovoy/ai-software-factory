import { describe, expect, test } from 'bun:test';
import { computeTraceMetrics, evaluateTraceCheck, isTestCommand } from '../src/trace';
import type { RunEvidence } from '../src/types';

function evidence(overrides: Partial<RunEvidence> = {}): RunEvidence {
  return {
    artifacts: [],
    artifactContents: {},
    toolCalls: [],
    usage: null,
    messages: null,
    fileEdits: [],
    patchBytes: 0,
    review: null,
    ...overrides,
  };
}

describe('trace scoring', () => {
  test('counts redundant test commands', () => {
    const metrics = computeTraceMetrics(
      evidence({
        toolCalls: [
          { name: 'bash', command: 'bun test', ok: true, seq: 1 },
          { name: 'bash', command: 'bun test', ok: true, seq: 2 },
          { name: 'bash', command: 'npm run build', ok: true, seq: 3 },
        ],
      }),
    );
    expect(metrics.testCommands).toBe(2);
    expect(metrics.redundantTestCommands).toBe(1);
    expect(isTestCommand('npx playwright test')).toBe(true);
  });

  test('redundant tests fail the trace check', () => {
    const result = evaluateTraceCheck(
      'redundant_tests',
      evidence({
        toolCalls: [
          { name: 'bash', command: 'bun test', ok: true, seq: 1 },
          { name: 'bash', command: 'bun test', ok: true, seq: 2 },
        ],
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.rationale).toContain('redundant');
  });

  test('verbosity uses usage and assistant text', () => {
    const result = evaluateTraceCheck(
      'verbosity',
      evidence({
        usage: {
          inputTokens: 1000,
          outputTokens: 10_000,
          costUsd: 0.1,
          cacheReadTokens: 0,
          reasoningTokens: 0,
        },
        messages: { assistantMessages: 1, assistantChars: 30_000, finalSummaryChars: 30_000 },
      }),
    );
    expect(result.ok).toBe(false);
  });

  test('scope checks changed files and patch bytes', () => {
    const result = evaluateTraceCheck(
      'scope',
      evidence({
        fileEdits: Array.from({ length: 21 }, (_, index) => ({
          path: `src/file-${index}.ts`,
          diffBytes: 10,
          addedLines: 1,
          removedLines: 0,
        })),
        patchBytes: 210,
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.rationale).toContain('21 changed file');
  });

  test('review usefulness requires findings and a summary', () => {
    const result = evaluateTraceCheck(
      'review_usefulness',
      evidence({ review: { verdict: 'approve', findings: 2, summaryChars: 80 } }),
    );
    expect(result.ok).toBe(true);

    const empty = evaluateTraceCheck(
      'review_usefulness',
      evidence({ review: { verdict: 'approve', findings: 0, summaryChars: 10 } }),
    );
    expect(empty.ok).toBe(false);
  });

  test('review usefulness is not applicable outside a review run', () => {
    const result = evaluateTraceCheck('review_usefulness', evidence());
    expect(result.ok).toBe(true);
    expect(result.rationale).toContain('not a review run');
  });
});
