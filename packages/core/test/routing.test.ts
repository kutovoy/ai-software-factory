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

  test('high risk forces the deep tier even when the classifier is disabled', () => {
    const choice = chooseRouting({
      routing: {
        stages: { implement: { model: 'stage-model' } },
        classifier: {
          enabled: false,
          cheap: { model: 'cheap-model' },
          standard: { model: 'standard-model' },
          deep: { model: 'deep-model' },
        },
      },
      prompt: 'update the readme typo',
      stage: 'implement',
      riskTier: 'high',
    });
    expect(choice.source).toBe('classifier');
    expect(choice.tier).toBe('deep');
    expect(choice.model).toBe('deep-model');
    expect(choice.reason).toContain('risk=high');
  });

  test('low or absent risk keeps the score-based tier', () => {
    const low = chooseRouting({
      routing,
      prompt: 'update the readme typo',
      stage: 'triage',
      riskTier: 'low',
      env: { CHEAP_MODEL: 'cheap', STANDARD_MODEL: 'standard', DEEP_MODEL: 'deep' },
    });
    expect(low.tier).toBe('cheap');

    const absent = chooseRouting({
      routing,
      prompt: 'Build a small Next.js page',
      stage: 'implement',
      env: { CHEAP_MODEL: 'cheap', STANDARD_MODEL: 'standard', DEEP_MODEL: 'deep' },
    });
    expect(absent.tier).toBe('standard');
    expect(absent.reason).not.toContain('risk=');
  });

  test('high risk without a classifier falls back to the stage route and records it', () => {
    const choice = chooseRouting({
      routing: {
        stages: { review: { model: 'review-model' } },
        default: { model: 'default-model' },
      },
      prompt: 'anything',
      stage: 'review',
      riskTier: 'high',
    });
    expect(choice.source).toBe('stage');
    expect(choice.model).toBe('review-model');
    expect(choice.reason).toContain('risk=high');
  });

  test('no routing stays honest and names the risk tier', () => {
    const choice = chooseRouting({ routing: null, prompt: 'anything', stage: 'review', riskTier: 'high' });
    expect(choice.source).toBe('none');
    expect(choice.tier).toBeNull();
    expect(choice.reason).toContain('risk=high');
  });
});
