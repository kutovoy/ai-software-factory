import { ApplicationFailure } from '@temporalio/activity';
import {
  appendWorkItemEvent,
  compileStageGraph,
  createVersion,
  createWorkItemIdempotent,
  derivedWorkItemId,
  findBenchmarkAttestation,
  foremanAgentName,
  getAutonomyState,
  loadDefinition,
  modelEnvName,
  recordAutomationFire,
  resolveAllGates,
  resolveModelRef,
  resolveStageConfigs,
  setAutomationFireWorkItem,
  stageDeclarationsFromDefinition,
  type AgentDef,
  type LoopStage,
  type WorkItemVersion,
} from '@factory/core';
import { benchmarkConfigHash, loadBenchmarkSuites } from '@factory/evals';
import { getSql } from '../db';
import { loadConfig } from '../config';
import { startFactoryWorkflow } from '../factory-client';
import type {
  AutomationWorkflowInput,
  AutomationWorkflowOutcome,
  FactoryWorkflowInput,
  LoopStageName,
  StageGraphSummary,
  StageNodeSummary,
} from '../types';
import { workItemWorkflowId } from '../types';

/**
 * Scheduled automation activity (spec `automations` › scheduled automations).
 *
 * One Temporal schedule fire → one work item → one `FactoryWorkflow`. The fire is keyed by
 * `(scheduleId, fireAt)`, and the work item id is derived from the same key, so a retried
 * activity (or a replayed schedule fire) never creates a second item.
 *
 * The stage graph is compiled from the definition exactly like the API does at creation, so
 * a broken definition fails here with a stable code instead of at dispatch time.
 */

function asFailure(error: unknown, type: string, details?: unknown): never {
  throw ApplicationFailure.create({
    type,
    nonRetryable: true,
    message: error instanceof Error ? error.message : String(error),
    ...(details === undefined ? {} : { details: [details] }),
  });
}

export async function fireAutomationActivity(
  args: AutomationWorkflowInput & { fireAt: string },
): Promise<AutomationWorkflowOutcome> {
  const sql = getSql();
  const config = loadConfig();

  const fire = await recordAutomationFire(sql, {
    scheduleId: args.scheduleId,
    fireAt: args.fireAt,
    factory: args.factory,
    automation: args.automation,
  });

  if (fire.duplicate) {
    return {
      factory: args.factory,
      automation: args.automation,
      fireAt: args.fireAt,
      workItemId: null,
      created: false,
      skipped: true,
      reason: 'duplicate_fire',
    };
  }

  const { definition, errors } = loadDefinition(args.factoryRoot);
  if (!definition) {
    return asFailure(new Error(`factory "${args.factory}" does not validate`), 'definition_invalid', {
      factory: args.factory,
      errors,
    });
  }

  const agents = definition.resources
    .filter((resource) => resource.kind === 'agent')
    .map((resource) => ({ name: resource.name, doc: resource.doc as AgentDef }));

  let graph: ReturnType<typeof compileStageGraph>;
  let configs: ReturnType<typeof resolveStageConfigs>;
  try {
    graph = compileStageGraph(stageDeclarationsFromDefinition(definition.manifest, agents));
    configs = resolveStageConfigs(graph, {
      manifest: definition.manifest,
      agents,
      spawner: foremanAgentName(agents),
    });
  } catch (error) {
    return asFailure(error, 'invalid_stage_graph', { factory: args.factory });
  }

  const nodes: StageNodeSummary[] = graph.nodes.map((node) => {
    const stageConfig = configs[node.name];
    return {
      name: node.name,
      needs: [...node.needs],
      agent: node.agent,
      reviewers: node.reviewers,
      gate: stageConfig.gate,
      gateSource: stageConfig.gateSource,
      gateStage: stageConfig.gateStage,
      harness: stageConfig.harness?.type ?? null,
      model: stageConfig.model,
      runner: stageConfig.runner as StageNodeSummary['runner'],
      tools: stageConfig.tools,
    };
  });
  const stageGraph: StageGraphSummary = {
    order: [...graph.order],
    fanOut: { ...graph.fanOut },
    nodes,
  };
  const gates: Record<string, string> = {};
  for (const node of graph.nodes) gates[node.name] = configs[node.name].gate;

  // Model references are configuration (ADR-028). A schedule fire is run creation: refuse
  // an unresolved env reference instead of forwarding the literal `env:...` upstream. The
  // fake harness needs no model, so it falls back to the fake model.
  const defaultHarness =
    args.harness ?? (definition.manifest.agentDefaults.harness?.type as never) ?? 'fake';
  const declaredDefault =
    args.model ??
    definition.manifest.agentDefaults.harness?.model ??
    definition.manifest.agentDefaults.model;
  const resolvedDefault = declaredDefault ? resolveModelRef(declaredDefault) : null;
  if (defaultHarness !== 'fake' && resolvedDefault?.value === null) {
    return asFailure(
      new Error(
        `model reference "${resolvedDefault.ref}" is unresolved: environment variable "${
          modelEnvName(resolvedDefault.ref) ?? resolvedDefault.ref
        }" is not set`,
      ),
      'model_unresolved',
      { factory: args.factory, ref: resolvedDefault.ref },
    );
  }
  const defaultModel =
    resolvedDefault?.value ?? (defaultHarness === 'fake' ? 'fake/fake-model' : undefined);

  const workItemId = derivedWorkItemId(`${args.scheduleId}@${args.fireAt}`);
  const workflowId = workItemWorkflowId(workItemId);
  const firstStage = graph.order[0] as LoopStageName;
  const title = args.title ?? `${args.automation} (scheduled ${args.fireAt})`;
  const sourceRef = {
    kind: 'schedule',
    scheduleId: args.scheduleId,
    automation: args.automation,
    cron: args.cron,
    fireAt: args.fireAt,
  };
  const prompt =
    args.prompt ??
    [
      title,
      '',
      `Source: scheduled automation "${args.automation}" (${args.cron})`,
      `Factory: ${args.factory}`,
      `Fire: ${args.fireAt}`,
    ].join('\n');

  let version: { commit: string; dirty: boolean };
  try {
    const record = createVersion(args.factoryRoot, { allowDirty: true });
    version = { commit: record.commit, dirty: record.dirty };
  } catch (error) {
    return asFailure(error, 'definition_not_versioned', { factory: args.factory });
  }

  const autonomy = await getAutonomyState(sql, args.factory);
  const definitionVersion: WorkItemVersion = 'stable';

  // Automation attestation parity (task 2.1): an automation-created item resolves autonomy
  // through exactly the same benchmark-attestation check as a manual item. When the gate
  // cannot be satisfied the item runs with human gates and records why (no silent downgrade).
  const resolution = resolveAllGates(definition.manifest);
  let benchmarkAttestationSatisfied = true;
  const suites: { suite: string; configHash: string; attested: boolean }[] = [];
  if (resolution.benchmarkGateRequired) {
    benchmarkAttestationSatisfied = false;
    for (const suite of loadBenchmarkSuites(definition)) {
      const configHash = benchmarkConfigHash(suite, version.commit);
      const attestation = await findBenchmarkAttestation(sql, {
        factory: args.factory,
        definitionCommit: version.commit,
        configHash,
      });
      const eligible =
        attestation?.passed === true &&
        attestation.calibrationOk === true &&
        attestation.partial === false;
      suites.push({ suite: suite.name, configHash, attested: eligible });
      if (eligible) benchmarkAttestationSatisfied = true;
    }
  }
  const override = Boolean(autonomy?.overrideActor && autonomy?.overrideReason);
  const benchmarkGateSatisfied =
    !resolution.benchmarkGateRequired || benchmarkAttestationSatisfied || override;
  const attestationMissing =
    resolution.benchmarkGateRequired && !benchmarkAttestationSatisfied && !override;

  const input: FactoryWorkflowInput = {
    workItemId,
    factory: args.factory,
    factoryRoot: args.factoryRoot,
    definitionCommit: version.commit,
    definitionDirty: version.dirty,
    title,
    prompt,
    sourceRef,
    repo: { path: config.factoryRoot },
    stageGraph,
    gates,
    mergePolicy: definition.manifest.mergePolicy,
    autonomy: {
      enabled: autonomy?.enabled ?? false,
      paused: autonomy?.paused ?? false,
      // Same resolution as the API: a passing, calibrated attestation for this commit +
      // config hash (or an explicit override) unlocks unattended gates.
      benchmarkGateSatisfied,
      actor: autonomy?.actor ?? null,
      reason: autonomy?.reason ?? null,
    },
    loopLimit: config.loopLimit,
    gateSlaMs: config.gateSlaMs,
    maxStagesPerRun: config.maxStagesPerRun,
    defaultHarness,
    ...(defaultModel ? { defaultModel } : {}),
    defaultRunner:
      args.runner ??
      ((definition.manifest.agentDefaults.runner as StageNodeSummary['runner']) ?? 'local-docker'),
    autoAllowPermissions: true,
    permissionTimeoutMs: config.permissionTimeoutMs,
  };

  const created = await createWorkItemIdempotent(sql, {
    id: workItemId,
    factory: args.factory,
    type: 'task',
    source: 'cron',
    sourceRef,
    title,
    stage: firstStage as LoopStage,
    definitionCommit: version.commit,
    definitionDirty: version.dirty,
    definitionVersion,
    workflowId,
    input: {
      stageGraph: stageGraph.order,
      gates,
      mergePolicy: definition.manifest.mergePolicy,
      benchmarkGate: {
        required: resolution.benchmarkGateRequired,
        satisfied: benchmarkGateSatisfied,
      },
    },
  });

  if (attestationMissing && created.created) {
    await appendWorkItemEvent(sql, {
      workItemId,
      type: 'autonomy.attestation_missing',
      stage: firstStage,
      actor: 'automation',
      payload: {
        factory: args.factory,
        automation: args.automation,
        definitionCommit: version.commit,
        suites,
        override,
        reason:
          'no passing, calibrated benchmark attestation matches this automation item\'s definition commit and configuration hash; the item runs with human gates',
      },
    });
  }

  await setAutomationFireWorkItem(sql, {
    scheduleId: args.scheduleId,
    fireAt: args.fireAt,
    workItemId,
  });

  if (created.created) {
    try {
      await startFactoryWorkflow(input, config);
    } catch (error) {
      // The workflow id is derived from the item, so an already-started run is the same
      // work; anything else is reported but does not fail the schedule fire.
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes('already')) {
        return asFailure(error, 'orchestrator_unavailable', { workItemId, message });
      }
    }
  }

  return {
    factory: args.factory,
    automation: args.automation,
    fireAt: args.fireAt,
    workItemId,
    created: created.created,
    skipped: false,
  };
}

/** The projection the console reads for the Automations page. */
export async function listAutomationSchedulesForApi(factory: string): Promise<
  Awaited<ReturnType<typeof import('@factory/core').listAutomationSchedules>>
> {
  const { listAutomationSchedules } = await import('@factory/core');
  return await listAutomationSchedules(getSql(), factory);
}

export { resolveAllGates };
