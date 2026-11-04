import { describe, expect, test } from 'bun:test';
import { chooseRouting, scoreTask, tierForScore } from '../src/routing/classify';
import type { RoutingDef } from '../src/schema/routing';

const routing: RoutingDef = {
  stages: {},
  classifier: {
    enabled: true,
    cheap: { model: 'env:CHEAP_MODEL' },
    standard: { model: 'env:STANDARD_MODEL' },
    deep: { model: 'env:DEEP_MODEL' },
  },
};

describe('model routing classifier', () => {
  test('triage and small docs tasks route cheap', () => {
    expect(tierForScore(scoreTask('update the readme typo', 'triage').score)).toBe('cheap');
  });

  test('review and long security tasks route deep', () => {
    const prompt = 'Review the authentication and encryption migration; check concurrency and database safety.';
    expect(tierForScore(scoreTask(prompt, 'review').score)).toBe('deep');
  });

  test('ordinary implementation routes standard', () => {
    expect(tierForScore(scoreTask('Build a small Next.js page', 'implement').score)).toBe(
      'standard',
    );
  });

  test('enabled classifier resolves the tier model from env', () => {
    const choice = chooseRouting({
      routing,
      prompt: 'Build a small Next.js page',
      stage: 'implement',
      env: { CHEAP_MODEL: 'cheap', STANDARD_MODEL: 'standard', DEEP_MODEL: 'deep' },
    });
    expect(choice.source).toBe('classifier');
    expect(choice.tier).toBe('standard');
    expect(choice.model).toBe('standard');
  });

  test('disabled classifier uses the explicit stage route', () => {
    const choice = chooseRouting({
      routing: {
        stages: { review: { model: 'review-model' } },
        default: { model: 'default-model' },
      },
      prompt: 'anything',
      stage: 'review',
    });
    expect(choice.source).toBe('stage');
    expect(choice.model).toBe('review-model');
  });
});
