import { describe, expect, test } from 'bun:test';
import {
  JudgeError,
  buildJudgePrompt,
  createOpenAIJudgeClient,
  createStubJudgeClient,
  parseJudgeOutput,
  runJudgeScorer,
  type RunContext,
} from '../src/judge';
import { registryEntry } from '../src/registry';
import type { ScorerRegistryEntry } from '../src/types';

function scopeScorer(): ScorerRegistryEntry {
  return registryEntry({
    name: 'scope',
    path: 'scorers/scope/scorer.md',
    body:
      'Compare the pull request against the work item. Return compliant when the change delivers exactly what the work item asks for.',
    doc: {
      description: 'Did the run deliver what the work item asked for?',
      labels: [
        { value: 'compliant', score: 1, description: 'delivers the request' },
        { value: 'partial', score: 0.5, description: 'delivers part of it' },
        { value: 'non_compliant', score: 0, description: 'does not deliver it' },
      ],
      passingScore: 1,
      samplingRate: 25,
      judgeModel: 'anthropic/claude-haiku-4-5',
      selfImprovement: true,
      output: 'classification',
    },
  });
}

function context(overrides: Partial<RunContext> = {}): RunContext {
  return {
    runId: 'run_01HZZZZZZZZZZZZZZZZZZZZZZ',
    factory: 'example',
    workItemId: 'wi_01HZZZZZZZZZZZZZZZZZZZZZZ',
    stage: 'implement',
    title: 'implement: fix the readme',
    status: 'ok',
    summary: 'done',
    prompt: 'fix the broken README link',
    diff: '@@ -1 +1 @@\n-# old\n+# new\n',
    artifacts: [{ path: 'patch.diff', kind: 'patch', bytes: 20 }],
    evidence: {
      artifacts: [{ path: 'patch.diff', kind: 'patch' }],
      artifactContents: {},
      toolCalls: [{ name: 'read_file', command: undefined, ok: true, seq: 2 }],
    },
    terminalSeq: 14,
    workItemTitle: 'fix the broken readme link',
    ...overrides,
  };
}

describe('judge prompt', () => {
  test('includes the rubric, labels and run context, and hashes deterministically', () => {
    const scorer = scopeScorer();
    const first = buildJudgePrompt(scorer, context());
    const second = buildJudgePrompt(scorer, context());
    expect(first.user).toContain(scorer.body.trim());
    expect(first.user).toContain('compliant (score 1)');
    expect(first.user).toContain('fix the broken README link');
    expect(first.user).toContain('patch.diff');
    expect(first.promptHash).toBe(second.promptHash);
    expect(first.promptHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test('a changed context changes the prompt hash', () => {
    const scorer = scopeScorer();
    const first = buildJudgePrompt(scorer, context());
    const second = buildJudgePrompt(scorer, context({ summary: 'different summary' }));
    expect(first.promptHash).not.toBe(second.promptHash);
  });
});

describe('strict label parsing', () => {
  const scorer = scopeScorer();

  test('parses JSON and derives score/passing from the label', () => {
    const parsed = parseJudgeOutput('{"label":"compliant","rationale":"scoped"}', scorer);
    expect(parsed).toEqual({ label: 'compliant', score: 1, passing: true, rationale: 'scoped' });
  });

  test('accepts an exact label and a single label token', () => {
    expect(parseJudgeOutput('partial', scorer).label).toBe('partial');
    expect(parseJudgeOutput('I would call this partial.', scorer).label).toBe('partial');
  });

  test('rejects an undeclared label', () => {
    expect(() => parseJudgeOutput('{"label":"great"}', scorer)).toThrow(JudgeError);
    try {
      parseJudgeOutput('{"label":"great"}', scorer);
    } catch (error) {
      expect((error as JudgeError).code).toBe('judge_invalid');
    }
  });

  test('rejects ambiguous output naming two labels', () => {
    expect(() => parseJudgeOutput('compliant or partial', scorer)).toThrow(JudgeError);
  });
});

describe('stub judge', () => {
  test('selects the highest label by default and records provenance', async () => {
    const scorer = scopeScorer();
    const result = await runJudgeScorer({
      scorer,
      client: createStubJudgeClient(),
      context: context(),
    });
    expect(result.label).toBe('compliant');
    expect(result.score).toBe(1);
    expect(result.passing).toBe(true);
    expect(result.provenance.judgeModel).toBe(scorer.judgeModel);
    expect(result.provenance.judgeModelVersion).toBe('stub-v1');
    expect(result.provenance.rubricHash).toBe(scorer.rubricHash);
    expect(result.provenance.promptHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.provenance.costUsd).toBe(0);
    expect(result.provenance.inputTokens).toBeGreaterThan(0);
  });

  test('a fixed stub label produces a non-passing score when below threshold', async () => {
    const result = await runJudgeScorer({
      scorer: scopeScorer(),
      client: createStubJudgeClient({ label: 'partial', rationale: 'missing scope' }),
      context: context(),
    });
    expect(result.label).toBe('partial');
    expect(result.score).toBe(0.5);
    expect(result.passing).toBe(false);
    expect(result.rationale).toBe('missing scope');
  });
});

describe('openai judge client (no network)', () => {
  test('parses a chat completion, usage and optional cost', async () => {
    const client = createOpenAIJudgeClient({
      baseUrl: 'https://judge.invalid/v1',
      apiKey: 'test-key',
      inputPricePer1k: 0.01,
      outputPricePer1k: 0.02,
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            model: 'judge-model-2026-01-01',
            choices: [{ message: { content: '{"label":"compliant","rationale":"ok"}' } }],
            usage: { prompt_tokens: 1000, completion_tokens: 500 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )) as unknown as typeof fetch,
    });

    const response = await client.complete({
      model: 'judge-model',
      system: 'system',
      user: 'user',
      labels: scopeScorer().labels,
    });
    expect(response.modelVersion).toBe('judge-model-2026-01-01');
    expect(response.inputTokens).toBe(1000);
    expect(response.outputTokens).toBe(500);
    expect(response.costUsd).toBeCloseTo(0.02);
  });

  test('a non-2xx response is judge_unavailable', async () => {
    const client = createOpenAIJudgeClient({
      baseUrl: 'https://judge.invalid/v1',
      fetchImpl: (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch,
    });
    await expect(
      client.complete({ model: 'm', system: 's', user: 'u', labels: scopeScorer().labels }),
    ).rejects.toBeInstanceOf(JudgeError);
  });
});
