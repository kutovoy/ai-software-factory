import type { AutomationDef } from '../schema/automation';
import {
  STAGES,
  type Gate,
  type MergePolicy,
  type Stage,
  isGate,
} from '../schema/common';
import type { FactoryManifest } from '../schema/factory';

export const GLOBAL_DEFAULT_GATE: Gate = 'human';

export type GateSource = 'automation' | 'factory' | 'global';

export interface ResolvedGate {
  stage: Stage;
  gate: Gate;
  source: GateSource;
}

function assertGate(value: string, where: string): Gate {
  if (!isGate(value)) {
    throw new Error(`${where}: invalid gate "${value}" (allowed: human, agent, policy:<name>)`);
  }
  return value;
}

/**
 * Precedence: automation override -> factory gates -> global default.
 * Pure function; validation already rejected invalid values upstream.
 */
export function resolveGate(
  stage: Stage,
  automation: AutomationDef | null | undefined,
  factory: FactoryManifest,
  globalDefault: Gate = GLOBAL_DEFAULT_GATE,
): ResolvedGate {
  const automationGate = automation?.gates?.[stage];
  if (automationGate !== undefined) {
    return { stage, gate: assertGate(automationGate, `automation.gates.${stage}`), source: 'automation' };
  }

  const factoryGate = factory.gates[stage];
  if (factoryGate !== undefined) {
    return { stage, gate: assertGate(factoryGate, `factory.gates.${stage}`), source: 'factory' };
  }

  return { stage, gate: assertGate(globalDefault, 'global default'), source: 'global' };
}

export interface GateResolution {
  stages: Record<Stage, ResolvedGate>;
  mergePolicy: MergePolicy;
  /** Every stage resolves to `agent` and the merge policy allows unattended merges. */
  fullyAutonomous: boolean;
  /** Autonomy may only be enabled after a benchmark non-regression gate exists. */
  benchmarkGateRequired: boolean;
}

export interface ResolveOptions {
  globalDefault?: Gate;
  /** When given, automation overrides are applied on top of the factory gates. */
  automation?: AutomationDef | null;
}

const AUTO_MERGE_POLICIES: readonly MergePolicy[] = ['auto_on_green', 'auto_after_n_approvals'];

export function resolveAllGates(
  factory: FactoryManifest,
  options: ResolveOptions = {},
): GateResolution {
  const stages = Object.fromEntries(
    STAGES.map((stage) => [
      stage,
      resolveGate(stage, options.automation ?? null, factory, options.globalDefault),
    ]),
  ) as Record<Stage, ResolvedGate>;

  const fullyAutonomous =
    STAGES.every((stage) => stages[stage].gate === 'agent') &&
    AUTO_MERGE_POLICIES.includes(factory.mergePolicy);

  return {
    stages,
    mergePolicy: factory.mergePolicy,
    fullyAutonomous,
    benchmarkGateRequired: fullyAutonomous,
  };
}
