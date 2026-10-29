import { describe, expect, it } from 'bun:test';
import {
  LOOP_STAGES,
  SpawnNotAllowedError,
  StageGraphError,
  compileStageGraph,
  defaultStageDeclarations,
  foremanAgentName,
  loadOrThrow,
  previousStage,
  resolveAllGates,
  resolveLoopGate,
  resolveStageConfigs,
  stageDeclarationsFromDefinition,
  type AgentDef,
  type LoopStage,
} from '../src/index';
import { EXAMPLE, LIGHTS_OFF } from './helpers';

function agent(
  name: string,
  doc: Partial<AgentDef> & { role?: AgentDef['role'] },
): { name: string; doc: AgentDef } {
  return { name, doc: doc as AgentDef };
}

describe('stage graph compiler', () => {
  it('compiles the default graph in order with needs edges', () => {
    const graph = compileStageGraph(defaultStageDeclarations());
    expect(graph.order).toEqual([...LOOP_STAGES]);
    expect(graph.nodes[0]).toMatchObject({ name: 'triage', needs: [] });
    expect(graph.nodes[1]).toMatchObject({ name: 'spec', needs: ['triage'] });
    expect(graph.nodes.at(-1)).toMatchObject({ name: 'ship', needs: ['verify'] });
  });

  it('defaults review fan-out to two independent reviewers', () => {
    const graph = compileStageGraph(defaultStageDeclarations());
    expect(graph.fanOut.review).toBe(2);
    expect(graph.fanOut.implement).toBe(1);
  });

  it('chains an ordered `stages:` list and fans out where declared', () => {
    const graph = compileStageGraph([
      { name: 'triage' },
      { name: 'spec' },
      { name: 'implement', needs: [] },
      { name: 'review', needs: ['spec', 'implement'], reviewers: 3 },
      { name: 'ship' },
    ]);
    expect(graph.order).toEqual(['triage', 'spec', 'implement', 'review', 'ship']);
    expect(graph.nodes.find((node) => node.name === 'review')?.needs).toEqual([
      'spec',
      'implement',
    ]);
    expect(graph.fanOut.review).toBe(3);
    expect(previousStage(graph, 'review')).toBe('implement');
    expect(previousStage(graph, 'triage')).toBeNull();
  });

  it('rejects an unknown stage naming the offending node', () => {
    let error: unknown;
    try {
      compileStageGraph([{ name: 'triage' }, { name: 'deploy' }]);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(StageGraphError);
    expect((error as StageGraphError).code).toBe('invalid_stage_graph');
    expect((error as StageGraphError).node).toBe('deploy');
    expect((error as StageGraphError).message).toContain('deploy');
  });

  it('rejects an unknown `needs` target', () => {
    expect(() =>
      compileStageGraph([{ name: 'spec', needs: ['deploy'] }]),
    ).toThrow(/unknown stage "deploy"/);
  });

  it('rejects a cycle naming the node it could not order', () => {
    let error: unknown;
    try {
      compileStageGraph([
        { name: 'spec', needs: ['implement'] },
        { name: 'implement', needs: ['spec'] },
      ]);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(StageGraphError);
    expect((error as StageGraphError).code).toBe('invalid_stage_graph');
    expect((error as StageGraphError).node).toBe('spec');
    expect((error as StageGraphError).message).toContain('cycle');
  });

  it('rejects duplicate stages', () => {
    expect(() => compileStageGraph([{ name: 'spec' }, { name: 'spec' }])).toThrow(
      /duplicate stage "spec"/,
    );
  });

  it('derives the example graph from agent roles (no plan agent, ship always present)', () => {
    const definition = loadOrThrow(EXAMPLE);
    const agents = definition.resources
      .filter((resource) => resource.kind === 'agent')
      .map((resource) => ({ name: resource.name, doc: resource.doc as AgentDef }));

    const declarations = stageDeclarationsFromDefinition(definition.manifest, agents);
    expect(declarations.map((declaration) => declaration.name)).toEqual([
      'triage',
      'spec',
      'implement',
      'review',
      'verify',
      'ship',
    ]);

    const graph = compileStageGraph(declarations);
    expect(graph.fanOut.review).toBe(2);
    expect(graph.nodes.find((node) => node.name === 'ship')?.agent).toBeNull();
  });

  it('derives a lights-off graph with every agent-gated stage', () => {
    const definition = loadOrThrow(LIGHTS_OFF);
    const agents = definition.resources
      .filter((resource) => resource.kind === 'agent')
      .map((resource) => ({ name: resource.name, doc: resource.doc as AgentDef }));
    const graph = compileStageGraph(stageDeclarationsFromDefinition(definition.manifest, agents));
    expect(graph.order).toEqual(['triage', 'spec', 'implement', 'review', 'verify', 'ship']);
  });
});

describe('per-stage config resolution', () => {
  const definition = loadOrThrow(EXAMPLE);
  const agents = definition.resources
    .filter((resource) => resource.kind === 'agent')
    .map((resource) => ({ name: resource.name, doc: resource.doc as AgentDef }));
  const graph = compileStageGraph(stageDeclarationsFromDefinition(definition.manifest, agents));

  it('resolves agent, harness/model, runner and tools per stage', () => {
    const configs = resolveStageConfigs(graph, {
      manifest: definition.manifest,
      agents,
      spawner: foremanAgentName(agents),
    });

    expect(configs.triage.agent).toBe('triage');
    expect(configs.triage.model).toBe('openai/gpt-5-mini');
    expect(configs.triage.runner).toBe('local-docker');

    expect(configs.implement.agent).toBe('implement');
    expect(configs.implement.tools).toEqual({
      allow: ['read', 'grep', 'edit', 'bash'],
      deny: ['git_push_force'],
    });

    expect(configs.review.model).toBe('anthropic/claude-sonnet-4-5');
    expect(configs.review.reviewers).toBe(2);

    // `ship` has no agent: it is the forge/merge stage.
    expect(configs.ship.agent).toBeNull();
    expect(configs.ship.model).toBe('openai/gpt-5');
  });

  it('inherits factory defaults when an agent declares no inference', () => {
    const configs = resolveStageConfigs(compileStageGraph([{ name: 'spec', agent: 'plain' }]), {
      manifest: definition.manifest,
      agents: [agent('plain', { role: 'spec' })],
    });
    expect(configs.spec.model).toBe('openai/gpt-5');
    expect(configs.spec.harness).toEqual({ type: 'opencode', model: 'openai/gpt-5' });
  });

  it('enforces spawnableBy: the foreman may spawn, another agent may not', () => {
    expect(() =>
      resolveStageConfigs(graph, {
        manifest: definition.manifest,
        agents,
        spawner: foremanAgentName(agents),
      }),
    ).not.toThrow();

    let error: unknown;
    try {
      resolveStageConfigs(graph, {
        manifest: definition.manifest,
        agents,
        spawner: 'implement',
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(SpawnNotAllowedError);
    expect((error as SpawnNotAllowedError).code).toBe('spawn_not_allowed');
    expect((error as SpawnNotAllowedError).agent).toBe('triage');
    expect((error as SpawnNotAllowedError).spawner).toBe('implement');
  });

  it('allows system dispatch and rejects agents with an empty spawnableBy list', () => {
    const graphOne = compileStageGraph([{ name: 'spec', agent: 'spec' }]);
    expect(() =>
      resolveStageConfigs(graphOne, {
        manifest: definition.manifest,
        agents: [agent('spec', { role: 'spec', spawnableBy: [] })],
      }),
    ).not.toThrow();

    expect(() =>
      resolveStageConfigs(graphOne, {
        manifest: definition.manifest,
        agents: [agent('spec', { role: 'spec', spawnableBy: [] })],
        spawner: 'foreman',
      }),
    ).toThrow(SpawnNotAllowedError);
  });

  it('forces every gate to human while autonomy is paused (kill switch)', () => {
    const configs = resolveStageConfigs(graph, {
      manifest: definition.manifest,
      agents,
      paused: true,
    });
    expect(Object.values(configs).every((config) => config.gate === 'human')).toBe(true);
  });
});

describe('loop gate resolution', () => {
  const definition = loadOrThrow(EXAMPLE);

  it('inherits the six-stage gate policy per loop stage', () => {
    const spec = resolveLoopGate('triage', null, definition.manifest);
    expect(spec).toMatchObject({ gateStage: 'spec', gate: 'human', source: 'factory' });

    expect(resolveLoopGate('implement', null, definition.manifest).gate).toBe('agent');
    expect(resolveLoopGate('review', null, definition.manifest).gate).toBe('agent');
    expect(resolveLoopGate('verify', null, definition.manifest)).toMatchObject({
      gateStage: 'implement',
      gate: 'agent',
    });
    expect(resolveLoopGate('ship', null, definition.manifest)).toMatchObject({
      gateStage: 'pr_review',
      gate: 'human',
    });
  });

  it('forceHuman overrides every policy (kill switch)', () => {
    const resolved = resolveLoopGate('implement', null, definition.manifest, { forceHuman: true });
    expect(resolved.gate).toBe('human');
    expect(resolved.gateStage).toBe('implement');
  });

  it('a lights-off factory resolves every loop gate to agent', () => {
    const lightsOff = loadOrThrow(LIGHTS_OFF);
    const resolution = resolveAllGates(lightsOff.manifest);
    expect(resolution.fullyAutonomous).toBe(true);
    for (const stage of LOOP_STAGES) {
      expect(resolveLoopGate(stage as LoopStage, null, lightsOff.manifest).gate).toBe('agent');
    }
  });
});
