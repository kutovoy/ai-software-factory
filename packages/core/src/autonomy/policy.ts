import type { GateResolution } from '../gates/resolve';

/**
 * Autonomy policy (lights-off) and the benchmark guardrail.
 *
 * `fullyAutonomous` (every gate `agent` + an unattended merge policy) sets
 * `benchmarkGateRequired`. Enabling autonomy is refused until a passing, calibrated
 * benchmark attestation matches the running definition commit + configuration hash
 * (ADR-018), unless an explicit override (actor + reason) is recorded. Pausing (the kill
 * switch) is always allowed.
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
  /**
   * True when a passing, calibrated benchmark attestation matches the running definition
   * commit + configuration hash (ADR-018). Defaults to false: an attestation is evidence,
   * never assumed.
   */
  benchmarkAttestationSatisfied?: boolean;
}

export function evaluateAutonomyRequest(input: EvaluateAutonomyInput): AutonomyDecision {
  const benchmarkGateRequired = input.resolution.benchmarkGateRequired;

  const carried: AutonomyOverride | null =
    input.current?.overrideActor && input.current?.overrideReason
      ? { actor: input.current.overrideActor, reason: input.current.overrideReason }
      : null;
  const override = input.request.override ?? carried;
  const benchmarkGateSatisfied =
    !benchmarkGateRequired || input.benchmarkAttestationSatisfied === true || override !== null;

  if (input.request.enabled && benchmarkGateRequired && !benchmarkGateSatisfied) {
    return {
      allowed: false,
      code: 'autonomy_refused',
      message:
        'enabling autonomy is refused: this factory requires a benchmark non-regression gate ' +
        'and no passing attestation matches its definition commit + configuration hash ' +
        '(benchmark_attestation_missing); run a benchmark or pass an explicit override ' +
        '{actor, reason} to proceed',
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
