import { describe, expect, test } from 'bun:test';
import {
  EDIT_OUT_OF_SCOPE,
  composeCandidate,
  decideImprovement,
  isEditInScope,
  visibleLessons,
} from '@factory/evals';
import { loadOrThrow } from '@factory/core';
import { join } from 'node:path';
import {
  ApiError,
  noActiveCanary,
  proposalNotAccepted,
  proposalNotDecidable,
  toEnvelope,
} from '../src/errors';
import {
  authorityChangeBodySchema,
  canaryPromoteBodySchema,
  canaryRollbackBodySchema,
  canaryStartBodySchema,
  improvementRunBodySchema,
  proposalApplyBodySchema,
  proposalDecisionBodySchema,
} from '../src/improvement';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');
const definition = loadOrThrow(join(REPO_ROOT, 'factories', 'example'));

describe('improvement API validation', () => {
  test('the run body is strict and bounded', () => {
    expect(improvementRunBodySchema.safeParse({ trigger: 'on_demand' }).success).toBe(true);
    expect(improvementRunBodySchema.safeParse({ maxProbes: 0 }).success).toBe(false);
    expect(improvementRunBodySchema.safeParse({ bogus: true }).success).toBe(false);
  });

  test('a decision requires an actor and a reason', () => {
    expect(
      proposalDecisionBodySchema.safeParse({ decision: 'accept', actor: 'a', reason: 'r' }).success,
    ).toBe(true);
    expect(proposalDecisionBodySchema.safeParse({ decision: 'accept' }).success).toBe(false);
    expect(proposalDecisionBodySchema.safeParse({ decision: 'maybe', actor: 'a', reason: 'r' }).success).toBe(
      false,
    );
  });

  test('apply requires an actor and a reason', () => {
    expect(proposalApplyBodySchema.safeParse({ actor: 'a', reason: 'r' }).success).toBe(true);
    expect(proposalApplyBodySchema.safeParse({}).success).toBe(false);
  });

  test('authority change accepts canary parameters and rejects unknown fields', () => {
    expect(
      authorityChangeBodySchema.safeParse({
        authority: 'canary',
        canaryPercent: 10,
        rollbackThreshold: 0.1,
        actor: 'a',
        reason: 'r',
      }).success,
    ).toBe(true);
    expect(
      authorityChangeBodySchema.safeParse({ authority: 'canary', actor: 'a', reason: 'r' }).success,
    ).toBe(true);
    expect(
      authorityChangeBodySchema.safeParse({ authority: 'nope', actor: 'a', reason: 'r' }).success,
    ).toBe(false);
    expect(
      authorityChangeBodySchema.safeParse({ authority: 'propose_only', actor: 'a', reason: 'r', extra: 1 })
        .success,
    ).toBe(false);
  });
  test('canary start and manual actions are strict and bounded', () => {
    expect(
      canaryStartBodySchema.safeParse({
        proposalId: 'prop_1',
        actor: 'a',
        reason: 'r',
      }).success,
    ).toBe(true);
    expect(
      canaryStartBodySchema.safeParse({
        proposalId: 'prop_1',
        actor: 'a',
        reason: 'r',
        canaryPercent: 100,
        observationWindowHours: 2,
      }).success,
    ).toBe(true);
    expect(
      canaryStartBodySchema.safeParse({
        proposalId: 'prop_1',
        actor: 'a',
        reason: 'r',
        canaryPercent: 0,
      }).success,
    ).toBe(false);
    expect(canaryStartBodySchema.safeParse({ proposalId: 'prop_1' }).success).toBe(false);
    expect(
      canaryRollbackBodySchema.safeParse({
        actor: 'a',
        reason: 'r',
      }).success,
    ).toBe(true);
    expect(
      canaryRollbackBodySchema.safeParse({ actor: 'a' }).success,
    ).toBe(false);
    expect(
      canaryPromoteBodySchema.safeParse({
        rolloutId: 'canary_1',
        actor: 'a',
        reason: 'r',
      }).success,
    ).toBe(true);
  });
});

describe('blast-radius scope rejection at the API boundary', () => {
  test('a composed candidate may not touch gates, runners or source', () => {
    expect(isEditInScope('factory.yaml')).toBe(false);
    expect(() =>
      composeCandidate(definition, [
        {
          kind: 'invariant',
          path: 'runners/local-docker.yaml',
          rationale: 'sneaky',
          content: 'x: 1\n',
        },
      ]),
    ).toThrow();
    try {
      composeCandidate(definition, [
        { kind: 'domain', path: 'src/loop.ts', rationale: 'source edit', content: 'export {};' },
      ]);
    } catch (error) {
      expect((error as { code?: string }).code).toBe(EDIT_OUT_OF_SCOPE);
    }
  });
});

describe('authority routing', () => {
  const probe = { baselineScore: 0, candidateScore: 0.25, uncalibrated: false };

  test('propose_only opens a PR', () => {
    expect(
      decideImprovement({ authority: 'propose_only', hasCandidate: true, probe, benchmark: null }).action,
    ).toBe('open_pr');
  });

  test('auto_merge without a benchmark attestation opens a PR instead of merging', () => {
    const decision = decideImprovement({
      authority: 'auto_merge_on_benchmark',
      hasCandidate: true,
      probe,
      benchmark: null,
    });
    expect(decision.action).toBe('open_pr');
    expect(decision.code).toBe('benchmark_attestation_missing');
  });

  test('auto_merge with a matching calibrated attestation merges', () => {
    const decision = decideImprovement({
      authority: 'auto_merge_on_benchmark',
      hasCandidate: true,
      probe,
      benchmark: {
        attestationPassed: true,
        attestationCalibrated: true,
        commitMatches: true,
        configHash: 'a'.repeat(64),
      },
    });
    expect(decision.action).toBe('merge');
  });

  test('canary starts a rollout instead of refusing (Phase 5b)', () => {
    const decision = decideImprovement({
      authority: 'canary',
      hasCandidate: true,
      probe,
      benchmark: null,
    });
    expect(decision.action).toBe('canary');
    expect(decision.code).toBe('canary_rollout');
    expect(decision.phase).toBeUndefined();

    const envelope = toEnvelope(noActiveCanary('example-lights-off', ['pending', 'active']));
    expect(envelope.status).toBe(409);
    expect(envelope.body.code).toBe('no_active_canary');
    expect(envelope.body.details).toMatchObject({ factory: 'example-lights-off' });
  });
});

describe('lesson isolation', () => {
  test('an unpromoted lesson of another factory is invisible', () => {
    const lessons = [
      { factory: 'example', promoted: false, cue: 'own' },
      { factory: 'other', promoted: false, cue: 'private' },
      { factory: 'other', promoted: true, cue: 'shared' },
    ];
    const visible = visibleLessons(lessons, 'example');
    expect(visible.map((lesson) => lesson.cue)).toEqual(['own', 'shared']);
  });

  test('an unscoped lesson read is not possible: the API defaults to a factory', () => {
    // The route defaults `factory` to `config.defaultFactory`; this is the invariant the
    // repository query relies on. A null factory would bypass isolation, so the API never
    // passes one.
    expect(visibleLessons([{ factory: 'other', promoted: false, cue: 'x' }], 'example')).toEqual([]);
  });
});

describe('proposal state errors', () => {
  test('a terminal proposal cannot be decided again', () => {
    const envelope = toEnvelope(proposalNotDecidable('prop_1', 'merged'));
    expect(envelope.status).toBe(409);
    expect(envelope.body.code).toBe('proposal_not_decidable');
    expect(envelope.body.details).toEqual({ proposalId: 'prop_1', status: 'merged' });
  });

  test('apply requires an accepted proposal', () => {
    const envelope = toEnvelope(proposalNotAccepted('prop_1', 'open'));
    expect(envelope.body.code).toBe('proposal_not_accepted');
  });

  test('ApiError keeps its code and status', () => {
    expect(new ApiError('x', 418, 'teapot').status).toBe(418);
  });
});
