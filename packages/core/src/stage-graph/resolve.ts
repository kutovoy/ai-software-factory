import { resolveLoopGate, type ResolvedLoopGate } from '../gates/loop';
import { assertModelAllowed, type GovernanceConfig } from '../governance/policy';
import { resolveModelRef, type ResolvedModel } from '../model/ref';
import { chooseRouting } from '../routing/classify';
import type { AutomationDef } from '../schema/automation';
import type { AgentDef } from '../schema/agent';
import type { Gate, HarnessType } from '../schema/common';
import type { FactoryManifest } from '../schema/factory';
import type { RoutingDef } from '../schema/routing';
import type { CompiledStageGraph, LoopStage } from './graph';

/**
 * Per-stage configuration resolution.
 *
 * Precedence for inference/runner/tools is agent -> factory `agentDefaults` -> none, the
 * same order the definition already uses everywhere else. `spawnableBy` is enforced here:
 * the dispatching agent (the foreman, or `null` for the system/API) must be listed on the
 * target agent, otherwise dispatch fails with `spawn_not_allowed`.
 */

export class SpawnNotAllowedError extends Error {
  readonly code = 'spawn_not_allowed' as const;
  readonly stage: LoopStage;
  readonly agent: string;
  readonly spawner: string | null;

  constructor(stage: LoopStage, agent: string, spawner: string | null, allowed: string[]) {
    super(
      `agent "${agent}" cannot be spawned by ${spawner ?? 'the system'} for stage "${stage}" ` +
        `(spawnableBy: ${allowed.length > 0 ? allowed.join(', ') : 'nobody'})`,
    );
    this.name = 'SpawnNotAllowedError';
    this.stage = stage;
    this.agent = agent;
    this.spawner = spawner;
  }
}

export interface StageAgentSource {
  name: string;
  doc: AgentDef;
}

export interface StageResolutionContext {
  manifest: FactoryManifest;
  agents: ReadonlyArray<StageAgentSource>;
  automation?: AutomationDef | null;
  /** Agent allowed to dispatch the stage agent. `null` = the system (API/workflow). */
  spawner?: string | null;
  /** Kill switch: force every gate to `human`. */
  paused?: boolean;
  globalDefaultGate?: Gate;
  /** Environment used to resolve `env:` model references. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Optional `routing.yaml`; enables classifier/stage routing. */
  routing?: RoutingDef | null;
  /** Work-item prompt used by the routing classifier. */
  taskPrompt?: string;
  /** Governance allowlist/policy for the factory. */
  governance?: GovernanceConfig | null;
}

export interface ResolvedStageConfig {
  stage: LoopStage;
  /** Agent that runs the stage; `null` for non-agent stages (e.g. `ship`). */
  agent: string | null;
  /** Declared harness, if the definition names one (model resolved when possible). */
  harness: { type: HarnessType; model: string } | null;
  /** Model the stage runs with (agent model -> defaults model -> harness model), resolved. */
  model: string | null;
  /**
   * The declared model as `{ref, value, source}` (ADR-028). `value` is `null` when an
   * `env:` reference is unset; `model` is then `null` too.
   */
  modelRef: ResolvedModel | null;
  runner: string;
  tools: { allow: string[]; deny: string[] } | null;
  reviewers: number;
  gate: Gate;
  gateSource: ResolvedLoopGate['source'];
  gateStage: ResolvedLoopGate['gateStage'];
}

function inferenceFor(
  agent: StageAgentSource | null,
  manifest: FactoryManifest,
  env: NodeJS.ProcessEnv,
  routing: RoutingDef | null,
  taskPrompt: string,
  stage: LoopStage,
): {
  harness: { type: HarnessType; model: string } | null;
  model: string | null;
  modelRef: ResolvedModel | null;
} {
  const routed = chooseRouting({ routing, prompt: taskPrompt, stage, env });
  const harness = routed.harness ?? agent?.doc.harness ?? manifest.agentDefaults.harness ?? null;
  const declared = routed.model ?? agent?.doc.model ?? manifest.agentDefaults.model ?? harness?.model ?? null;
  const modelRef = declared === null ? null : resolveModelRef(declared, env);
  const harnessModel = harness ? resolveModelRef(harness.model, env).value ?? harness.model : null;
  return {
    harness: harness && harnessModel !== null ? { type: harness.type, model: harnessModel } : null,
    model: routed.model ?? modelRef?.value ?? null,
    modelRef,
  };
}

/** Throws `SpawnNotAllowedError` when `spawner` is not listed on the target agent. */
export function assertSpawnAllowed(
  target: { name: string; spawnableBy?: string[] | undefined },
  spawner: string | null,
  stage: LoopStage,
): void {
  if (spawner === null) return; // system/API dispatch is always allowed
  if (target.spawnableBy === undefined) return; // no restriction declared
  if (target.spawnableBy.includes(spawner)) return;
  throw new SpawnNotAllowedError(stage, target.name, spawner, target.spawnableBy);
}

export function resolveStageConfigs(
  graph: CompiledStageGraph,
  context: StageResolutionContext,
): Record<string, ResolvedStageConfig> {
  const byName = new Map(context.agents.map((agent) => [agent.name, agent]));
  const spawner = context.spawner ?? null;
  const env = context.env ?? process.env;
  const configs: Record<string, ResolvedStageConfig> = {};

  for (const node of graph.nodes) {
    const agent = node.agent ? (byName.get(node.agent) ?? null) : null;
    if (node.agent && !agent) {
      throw new Error(
        `stage "${node.name}" references agent "${node.agent}" which is not defined`,
      );
    }

    if (agent) assertSpawnAllowed({ name: agent.name, spawnableBy: agent.doc.spawnableBy }, spawner, node.name);

    const inference = inferenceFor(
      agent,
      context.manifest,
      env,
      context.routing ?? null,
      context.taskPrompt ?? '',
      node.name,
    );
    assertModelAllowed(context.governance, inference.model);
    const gate = resolveLoopGate(node.name, context.automation ?? null, context.manifest, {
      ...(context.globalDefaultGate ? { globalDefault: context.globalDefaultGate } : {}),
      ...(context.paused ? { forceHuman: true } : {}),
    });

    configs[node.name] = {
      stage: node.name,
      agent: agent?.name ?? null,
      harness: inference.harness,
      model: inference.model,
      modelRef: inference.modelRef,
      runner: agent?.doc.runner ?? context.manifest.agentDefaults.runner ?? 'local-docker',
      tools: agent?.doc.tools
        ? {
            allow: [...(agent.doc.tools.allow ?? [])],
            deny: [...(agent.doc.tools.deny ?? [])],
          }
        : null,
      reviewers: node.reviewers,
      gate: gate.gate,
      gateSource: gate.source,
      gateStage: gate.gateStage,
    };
  }

  return configs;
}

/** The foreman agent of a definition, used as the default `spawner` for dispatch. */
export function foremanAgentName(
  agents: ReadonlyArray<StageAgentSource>,
): string | null {
  return agents.find((agent) => agent.doc.role === 'foreman')?.name ?? null;
}
