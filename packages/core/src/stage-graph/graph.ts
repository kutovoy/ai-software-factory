import type { AgentDef } from '../schema/agent';
import type { FactoryManifest } from '../schema/factory';
import type { StageDeclarationDef } from '../schema/stage';

/**
 * Stage graph compiler.
 *
 * The factory loop is a DAG over a small, fixed vocabulary of stages. The graph is
 * compiled from the definition (`stages:`, ordered) or derived from the agents' roles, then
 * validated: unknown stage names, unknown `needs` targets and cycles all fail with
 * `invalid_stage_graph` naming the offending node.
 *
 * Fan-out is a property of a node: the `review` stage declares `reviewers` (default 2) and
 * the orchestrator spawns that many independent children in parallel. `needs` edges order
 * distinct stages.
 */

export const LOOP_STAGES = [
  'triage',
  'spec',
  'plan',
  'implement',
  'review',
  'verify',
  'ship',
] as const;

export type LoopStage = (typeof LOOP_STAGES)[number];

/** The review committee runs at least two independent reviewers (spec: review committee). */
export const DEFAULT_REVIEWERS = 2;

export interface StageDeclaration {
  name: string;
  needs?: string[];
  agent?: string;
  reviewers?: number;
}

export interface StageNode {
  name: LoopStage;
  /** Declaration order, used for stable topological ordering. */
  index: number;
  needs: LoopStage[];
  agent: string | null;
  reviewers: number;
}

export interface CompiledStageGraph {
  nodes: StageNode[];
  /** Topological order; ties are broken by declaration order. */
  order: LoopStage[];
  /** Parallel children per stage (1 for everything except `review` by default). */
  fanOut: Record<string, number>;
}

export class StageGraphError extends Error {
  readonly code = 'invalid_stage_graph' as const;
  readonly node: string;

  constructor(node: string, message: string) {
    super(message);
    this.name = 'StageGraphError';
    this.node = node;
  }
}

export function isLoopStage(value: string): value is LoopStage {
  return (LOOP_STAGES as readonly string[]).includes(value);
}

/** The full ordered graph with sequential `needs` edges. */
export function defaultStageDeclarations(): StageDeclaration[] {
  return LOOP_STAGES.map((name, index) => ({
    name,
    needs: index === 0 ? [] : [LOOP_STAGES[index - 1]],
    ...(name === 'review' ? { reviewers: DEFAULT_REVIEWERS } : {}),
  }));
}

/**
 * Derives the stage graph from a definition:
 *  - an explicit `stages:` block wins (ordered; each entry needs the previous one unless
 *    it declares `needs`, and `needs: []` starts a parallel branch);
 *  - otherwise every agent whose `role` matches a loop stage contributes that stage, in
 *    the canonical order, and `ship` is always present (it is a forge/merge stage, not an
 *    agent run).
 */
export function stageDeclarationsFromDefinition(
  manifest: FactoryManifest,
  agents: ReadonlyArray<{ name: string; doc: AgentDef }>,
): StageDeclaration[] {
  if (manifest.stages && manifest.stages.length > 0) {
    return manifest.stages.map((declaration) => ({
      name: declaration.name,
      ...(declaration.needs ? { needs: [...declaration.needs] } : {}),
      ...(declaration.agent ? { agent: declaration.agent } : {}),
      ...(declaration.reviewers ? { reviewers: declaration.reviewers } : {}),
    }));
  }

  const byRole = new Map<string, string>();
  for (const agent of agents) {
    const role = agent.doc.role;
    if (role && !byRole.has(role)) byRole.set(role, agent.name);
  }

  const declarations: StageDeclaration[] = [];
  let previous: string | null = null;
  for (const stage of LOOP_STAGES) {
    if (stage === 'ship') {
      declarations.push({ name: 'ship', needs: previous ? [previous] : [] });
      continue;
    }
    const agent = byRole.get(stage);
    if (!agent) continue;
    declarations.push({
      name: stage,
      needs: previous ? [previous] : [],
      agent,
      ...(stage === 'review' ? { reviewers: DEFAULT_REVIEWERS } : {}),
    });
    previous = stage;
  }

  if (declarations.length === 0) {
    throw new StageGraphError(
      '<root>',
      'no agent declares a loop stage role and factory.yaml declares no stages',
    );
  }

  return declarations;
}

function normalize(declarations: readonly (StageDeclaration | StageDeclarationDef)[]): StageDeclaration[] {
  return declarations.map((declaration, index) => {
    const previous = index === 0 ? undefined : declarations[index - 1]?.name;
    const needs =
      declaration.needs !== undefined
        ? [...declaration.needs]
        : previous !== undefined
          ? [previous]
          : [];
    return {
      name: declaration.name,
      needs,
      ...(declaration.agent ? { agent: declaration.agent } : {}),
      ...(declaration.reviewers !== undefined ? { reviewers: declaration.reviewers } : {}),
    };
  });
}

export function compileStageGraph(
  declarations: readonly (StageDeclaration | StageDeclarationDef)[],
): CompiledStageGraph {
  if (!Array.isArray(declarations) || declarations.length === 0) {
    throw new StageGraphError('<root>', 'the stage graph declares no stages');
  }

  const normalized = normalize(declarations);
  const positions = new Map<string, number>();

  for (const [index, declaration] of normalized.entries()) {
    if (!isLoopStage(declaration.name)) {
      throw new StageGraphError(
        declaration.name,
        `unknown stage "${declaration.name}" (allowed: ${LOOP_STAGES.join(', ')})`,
      );
    }
    if (positions.has(declaration.name)) {
      throw new StageGraphError(
        declaration.name,
        `duplicate stage "${declaration.name}" in the stage graph`,
      );
    }
    positions.set(declaration.name, index);
  }

  for (const declaration of normalized) {
    for (const need of declaration.needs ?? []) {
      if (!positions.has(need)) {
        throw new StageGraphError(
          need,
          `stage "${declaration.name}" needs unknown stage "${need}"`,
        );
      }
    }
  }

  const nodes: StageNode[] = normalized.map((declaration, index) => {
    const name = declaration.name as LoopStage;
    return {
      name,
      index,
      needs: (declaration.needs ?? []) as LoopStage[],
      agent: declaration.agent ?? null,
      reviewers:
        declaration.reviewers ?? (name === 'review' ? DEFAULT_REVIEWERS : 1),
    };
  });

  const dependents = new Map<string, string[]>();
  const indegree = new Map<string, number>();
  for (const node of nodes) {
    indegree.set(node.name, node.needs.length);
    for (const need of node.needs) {
      const list = dependents.get(need) ?? [];
      list.push(node.name);
      dependents.set(need, list);
    }
  }

  const byIndex = (left: string, right: string): number =>
    (positions.get(left) ?? 0) - (positions.get(right) ?? 0);

  const ready: string[] = nodes.filter((node) => node.needs.length === 0).map((node) => node.name);
  ready.sort(byIndex);

  const order: LoopStage[] = [];
  while (ready.length > 0) {
    const name = ready.shift() as string;
    order.push(name as LoopStage);
    for (const dependent of dependents.get(name) ?? []) {
      const remaining = (indegree.get(dependent) ?? 0) - 1;
      indegree.set(dependent, remaining);
      if (remaining === 0) {
        ready.push(dependent);
        ready.sort(byIndex);
      }
    }
  }

  if (order.length !== nodes.length) {
    const stuck = nodes.find((node) => !order.includes(node.name));
    throw new StageGraphError(
      stuck?.name ?? '<root>',
      `cycle detected in the stage graph at "${stuck?.name ?? '<root>'}"`,
    );
  }

  const fanOut: Record<string, number> = {};
  for (const node of nodes) fanOut[node.name] = node.reviewers;

  return { nodes, order, fanOut };
}

/** The stage that runs before `stage` in the compiled order, or `null` for the first. */
export function previousStage(graph: CompiledStageGraph, stage: LoopStage): LoopStage | null {
  const index = graph.order.indexOf(stage);
  return index > 0 ? (graph.order[index - 1] as LoopStage) : null;
}
