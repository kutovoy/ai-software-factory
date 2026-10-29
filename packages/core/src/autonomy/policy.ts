import type { GateResolution } from '../gates/resolve';

/**
 * Autonomy policy (lights-off) and the benchmark guardrail.
 *
 * `fullyAutonomous` (every gate `agent` + an unattended merge policy) sets
 * `benchmarkGateRequired`. Until Phase 4 benchmarks exist that flag is unresolved, so
 * enabling autonomy is refused unless an explicit override (actor + reason) is recorded.
 * Pausing (the kill switch) is always allowed.
 */

export interface AutonomyOverride {
  actor: string;
  reason: string;
}

export interface AutonomyRequest {
  enabled: boolean;
  actor: string;
  reason: string;
  override?: AutonomyOverride;
}

export interface AutonomyStateLike {
  enabled: boolean;
  paused: boolean;
  overrideActor?: string | null;
  overrideReason?: string | null;
}

export interface AutonomyDecision {
  allowed: boolean;
  /** Stable code for the refusal; only set when `allowed` is false. */
  code?: 'autonomy_refused';
  message?: string;
  benchmarkGateRequired: boolean;
  benchmarkGateSatisfied: boolean;
  /** Override recorded on the state (new or carried over). */
  override: AutonomyOverride | null;
}

export interface EvaluateAutonomyInput {
  resolution: GateResolution;
  request: AutonomyRequest;
  current?: AutonomyStateLike | null;
}

export function evaluateAutonomyRequest(input: EvaluateAutonomyInput): AutonomyDecision {
  const benchmarkGateRequired = input.resolution.benchmarkGateRequired;

  const carried: AutonomyOverride | null =
    input.current?.overrideActor && input.current?.overrideReason
      ? { actor: input.current.overrideActor, reason: input.current.overrideReason }
      : null;
  const override = input.request.override ?? carried;
  const benchmarkGateSatisfied = !benchmarkGateRequired || override !== null;

  if (input.request.enabled && benchmarkGateRequired && !benchmarkGateSatisfied) {
    return {
      allowed: false,
      code: 'autonomy_refused',
      message:
        'enabling autonomy is refused: this factory requires a benchmark non-regression gate ' +
        'that does not exist yet (Phase 4); pass an explicit override {actor, reason} to proceed',
      benchmarkGateRequired,
      benchmarkGateSatisfied,
      override: null,
    };
  }

  return {
    allowed: true,
    benchmarkGateRequired,
    benchmarkGateSatisfied,
    override,
  };
}
