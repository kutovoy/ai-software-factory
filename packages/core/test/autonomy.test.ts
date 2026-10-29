import { describe, expect, it } from 'bun:test';
import {
  evaluateAutonomyRequest,
  loadOrThrow,
  resolveAllGates,
  type AutonomyRequest,
} from '../src/index';
import { EXAMPLE, LIGHTS_OFF } from './helpers';

const ENABLE: AutonomyRequest = {
  enabled: true,
  actor: 'ada',
  reason: 'run lights-off',
};

describe('autonomy policy', () => {
  it('refuses enabling autonomy while the benchmark gate is required and unresolved', () => {
    const resolution = resolveAllGates(loadOrThrow(LIGHTS_OFF).manifest);
    expect(resolution.benchmarkGateRequired).toBe(true);

    const decision = evaluateAutonomyRequest({ resolution, request: ENABLE });
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe('autonomy_refused');
    expect(decision.benchmarkGateRequired).toBe(true);
    expect(decision.benchmarkGateSatisfied).toBe(false);
    expect(decision.message).toContain('benchmark');
  });

  it('allows enabling with an explicit override actor + reason', () => {
    const resolution = resolveAllGates(loadOrThrow(LIGHTS_OFF).manifest);
    const decision = evaluateAutonomyRequest({
      resolution,
      request: {
        ...ENABLE,
        override: { actor: 'grace', reason: 'accepted risk until Phase 4 benchmarks exist' },
      },
    });
    expect(decision.allowed).toBe(true);
    expect(decision.benchmarkGateSatisfied).toBe(true);
    expect(decision.override).toEqual({
      actor: 'grace',
      reason: 'accepted risk until Phase 4 benchmarks exist',
    });
  });

  it('carries a previously recorded override forward', () => {
    const resolution = resolveAllGates(loadOrThrow(LIGHTS_OFF).manifest);
    const decision = evaluateAutonomyRequest({
      resolution,
      request: ENABLE,
      current: {
        enabled: false,
        paused: false,
        overrideActor: 'grace',
        overrideReason: 'accepted risk',
      },
    });
    expect(decision.allowed).toBe(true);
    expect(decision.override?.actor).toBe('grace');
  });

  it('allows enabling on a factory that does not require the benchmark gate', () => {
    const resolution = resolveAllGates(loadOrThrow(EXAMPLE).manifest);
    expect(resolution.benchmarkGateRequired).toBe(false);

    const decision = evaluateAutonomyRequest({ resolution, request: ENABLE });
    expect(decision.allowed).toBe(true);
    expect(decision.benchmarkGateSatisfied).toBe(true);
  });

  it('always allows pausing (kill switch)', () => {
    const resolution = resolveAllGates(loadOrThrow(LIGHTS_OFF).manifest);
    const decision = evaluateAutonomyRequest({
      resolution,
      request: { enabled: false, actor: 'ada', reason: 'kill switch' },
    });
    expect(decision.allowed).toBe(true);
  });
});
