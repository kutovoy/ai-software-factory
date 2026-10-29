import type { AutomationDef } from '../schema/automation';
import type { Gate, Stage } from '../schema/common';
import type { FactoryManifest } from '../schema/factory';
import { resolveGate, type GateSource, type ResolvedGate } from './resolve';
import type { LoopStage } from '../stage-graph/graph';

/**
 * Loop stages are a superset of the six gate stages in `factory.yaml`. A loop stage with
 * no gate of its own inherits the nearest gate in the six-stage policy:
 *
 *   triage  -> spec      (intake is approved like a spec)
 *   spec    -> spec
 *   plan    -> plan
 *   implement -> implement
 *   review  -> review
 *   verify  -> implement (a post-implementation automated check)
 *   ship    -> pr_review (the merge gate)
 */
export const LOOP_STAGE_GATE_ALIAS: Record<LoopStage, Stage> = {
  triage: 'spec',
  spec: 'spec',
  plan: 'plan',
  implement: 'implement',
  review: 'review',
  verify: 'implement',
  ship: 'pr_review',
};

export interface ResolvedLoopGate extends ResolvedGate {
  loopStage: LoopStage;
  /** The six-stage policy key the gate was resolved from. */
  gateStage: Stage;
}

export interface ResolveLoopGateOptions {
  globalDefault?: Gate;
  /** Kill switch: every gate resolves to `human` while autonomy is paused. */
  forceHuman?: boolean;
}

export function resolveLoopGate(
  loopStage: LoopStage,
  automation: AutomationDef | null | undefined,
  factory: FactoryManifest,
  options: ResolveLoopGateOptions = {},
): ResolvedLoopGate {
  const gateStage = LOOP_STAGE_GATE_ALIAS[loopStage];
  const resolved = resolveGate(gateStage, automation ?? null, factory, options.globalDefault);

  if (options.forceHuman) {
    return {
      loopStage,
      gateStage,
      stage: gateStage,
      gate: 'human',
      source: 'global' satisfies GateSource,
    };
  }

  return { loopStage, gateStage, stage: resolved.stage, gate: resolved.gate, source: resolved.source };
}
