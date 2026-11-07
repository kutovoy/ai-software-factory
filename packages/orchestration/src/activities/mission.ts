import { ApplicationFailure } from '@temporalio/activity';
import {
  appendMissionEvent,
  assertionsForMilestone,
  compileStageGraph,
  createMissionFeature,
  createMissionGate,
  createMissionValidation,
  createWorkItem,
  foremanAgentName,
  getAutonomyState,
  getMission,
  getPendingMissionGate,
  getWorkItem,
  listMissionCheckpoints,
  listMissionFeatures,
  listMissionMilestones,
  listMissionValidations,
  listMissionWorkItems,
  loadDefinition,
  missionBudgetExceeded,
  missionBudgetUsage,
  newMissionFeatureId,
  newMissionValidationId,
  newWorkItemId,
  parseValidationEvidence,
  persistMissionPlan,
  readMissionCancel,
  recordMissionCheckpoint,
  resolveAllGates,
  resolveModelRef,
  resolveStageConfigs,
  setMissionFeatureStatus,
  setMissionMilestoneStatus,
  setMissionPlan,
  stageDeclarationsFromDefinition,
  updateMissionStatus,
  updateMissionValidation,
  validateMissionPlan,
  type AgentDef,
  type Mission,
  type MissionCheckpoint,
  type MissionFeature,
  type MissionFeaturePlan,
  type MissionFeatureStatus,
  type MissionGate,
  type MissionMilestone,
  type MissionMilestoneStatus,
  type MissionPlan,
  type MissionValidationKind,
  type RoutingDef,
  type WorkItemType,
} from '@factory/core';
import { loadConfig } from '../config';
import { getRun, getSql, insertRun } from '../db';
import { getMissionPlanner } from '../models/mission-planner';
import {
  missionValidationRunId,
  runWorkflowIdFor,
  workItemWorkflowId,
  type FactoryWorkflowInput,
  type HarnessId,
  type MissionPlanData,
  type RunInput,
  type RunnerKindName,
  type StageGraphSummary,
  type StageNodeSummary,
} from '../types';

/**
 * Mission activities (roadmap item 12).
 *
 * The workflow is deterministic; every read/write, model call and child dispatch boundary
 * lives here. Activities are idempotent where Temporal can replay them: plan persistence
 * upserts, checkpoints/events dedupe, validation preparation reuses the deterministic run
 * id, and fix features are skipped when an identical fix already exists.
 */

function missionNotFound(missionId: string): ApplicationFailure {
  return ApplicationFailure.create({
    type: 'mission_not_found',
    nonRetryable: true,
    message: `mission ${missionId} does not exist`,
    details: [{ missionId }],
  });
}

function invalidPlan(errors: string[]): ApplicationFailure {
  return ApplicationFailure.create({
    type: 'mission_plan_invalid',
    nonRetryable: true,
    message: `mission plan is invalid: ${errors.join('; ')}`,
    details: [{ errors }],
  });
}

function definitionFailure(factory: string, errors: unknown[]): ApplicationFailure {
  return ApplicationFailure.create({
    type: 'definition_invalid',
    nonRetryable: true,
    message: `factory "${factory}" does not validate`,
    details: [{ factory, errors }],
  });
}

function asPlan(plan: MissionPlan | null): MissionPlanData | null {
  return plan as MissionPlanData | null;
}

function mapRunner(name: string | undefined): RunnerKindName {
  if (!name) return 'local-docker';
  if (name.includes('remote')) return 'remote';
  if (name.includes('docker')) return 'local-docker';
  if (name.includes('process') || name.includes('local')) return 'local-process';
  return 'local-docker';
}

interface DefinitionContext {
  definition: NonNullable<ReturnType<typeof loadDefinition>['definition']>;
  agents: { name: string; doc: AgentDef }[];
  graph: ReturnType<typeof compileStageGraph>;
  configs: ReturnType<typeof resolveStageConfigs>;
  stageGraph: StageGraphSummary;
  gates: Record<string, string>;
}

/** Compiles the definition exactly like the API does before starting a work item. */
function compileMissionLoop(
  mission: Mission,
  taskPrompt: string,
): DefinitionContext {
  const { definition, errors } = loadDefinition(mission.factoryRoot);
  if (!definition) throw definitionFailure(mission.factory, errors);

  const agents = definition.resources
    .filter((resource) => resource.kind === 'agent')
    .map((resource) => ({ name: resource.name, doc: resource.doc as AgentDef }));

  const graph = compileStageGraph(stageDeclarationsFromDefinition(definition.manifest, agents));
  const routing = (definition.resources.find((resource) => resource.kind === 'routing')?.doc ??
    null) as RoutingDef | null;

  const configs = resolveStageConfigs(graph, {
    manifest: definition.manifest,
    agents,
    spawner: foremanAgentName(agents),
    taskPrompt,
    ...(routing ? { routing } : {}),
    ...(definition.manifest.governance
      ? { governance: definition.manifest.governance }
      : {}),
  });

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

  const gates: Record<string, string> = {};
  for (const node of graph.nodes) gates[node.name] = configs[node.name].gate;

  return {
    definition,
    agents,
    graph,
    configs,
    stageGraph: { order: [...graph.order], fanOut: { ...graph.fanOut }, nodes },
    gates,
  };
}

function harnessOverride(): HarnessId | undefined {
  const value = process.env.MISSION_HARNESS;
  return value ? (value as HarnessId) : undefined;
}

function defaultHarness(definition: DefinitionContext['definition']): HarnessId {
  return (definition.manifest.agentDefaults.harness?.type ?? 'opencode') as HarnessId;
}

function resolveModel(declared: string | null | undefined, harness: HarnessId): string | undefined {
  if (!declared) return harness === 'fake' ? 'fake/fake-model' : undefined;
  const value = resolveModelRef(declared, process.env).value;
  if (value) return value;
  return harness === 'fake' ? 'fake/fake-model' : undefined;
}

function compactCheckpoint(checkpoint: MissionCheckpoint): string {
  const state = checkpoint.state;
  const title =
    typeof state.title === 'string'
      ? state.title
      : typeof state.featureTitle === 'string'
        ? state.featureTitle
        : typeof state.milestoneTitle === 'string'
          ? state.milestoneTitle
          : checkpoint.featureId ?? checkpoint.milestoneId ?? '';
  const round = typeof state.round === 'number' ? ` (round ${state.round})` : '';
  return `- ${checkpoint.kind}: ${title}${round}`;
}

/**
 * Fresh context pack for one feature (design decision 4): mission goal, the feature spec,
 * its assertions and a compact shared state. The full mission history is never replayed.
 */
function featurePrompt(args: {
  mission: Mission;
  plan: MissionPlanData;
  milestone: MissionMilestone;
  feature: MissionFeature;
  checkpoints: MissionCheckpoint[];
}): string {
  const { mission, plan, milestone, feature, checkpoints } = args;
  const assertions = plan.validationContract.assertions.filter((assertion) =>
    feature.acceptanceCheckIds.includes(assertion.id),
  );
  const shared = checkpoints
    .filter(
      (checkpoint) =>
        checkpoint.kind === 'feature.done' ||
        checkpoint.kind === 'milestone.done' ||
        checkpoint.kind === 'validation.failed',
    )
    .slice(-12)
    .map(compactCheckpoint);

  return [
    `Mission: ${mission.title}`,
    `Goal:\n${mission.goal}`,
    '',
    `Milestone: ${milestone.title}`,
    milestone.description,
    '',
    `Feature: ${feature.title}`,
    feature.description,
    '',
    'Acceptance assertions:',
    ...assertions.map(
      (assertion) =>
        `- [${assertion.id}] ${assertion.title}: ${assertion.assertion} (evidence: ${assertion.evidence}${assertion.command ? `, command: ${assertion.command}` : ''})`,
    ),
    '',
    shared.length > 0 ? `Shared state:\n${shared.join('\n')}` : 'Shared state: nothing completed yet.',
    '',
    `Definition commit: ${mission.definitionCommit}`,
    'Implement only this feature. Do not replay or redo completed mission work.',
  ].join('\n');
}

/**
 * A milestone validation round runs two fresh validators. Scrutiny owns the code/build
 * assertions; user-testing owns the behavioral/e2e assertions. Each validator only reports
 * the assertions it can actually exercise, so a missing browser assertion in scrutiny is
 * not turned into a code fix feature.
 */
function assertionsForKind(
  plan: MissionPlanData,
  milestoneId: string,
  kind: MissionValidationKind,
): MissionPlanData['validationContract']['assertions'] {
  const ids = assertionsForMilestone(plan as MissionPlan, milestoneId);
  return plan.validationContract.assertions.filter((assertion) => {
    if (!ids.has(assertion.id)) return false;
    if (kind === 'contract') return true;
    if (kind === 'scrutiny') {
      return assertion.tier === 'unit' || assertion.tier === 'component' || assertion.tier === 'integration';
    }
    return assertion.tier === 'e2e' || assertion.tier === 'manual';
  });
}

/**
 * Mission validation runs against the integrated forge repository, not the central
 * factory checkout. Local runners clone the internal Forgejo URL on the worker host;
 * remote runners use the externally reachable `RUNNER_REPO_URL`.
 */
function validationRepo(
  definition: DefinitionContext['definition'],
  runner: RunnerKindName,
): { url: string } | { path: string } {
  const config = loadConfig();
  if (runner === 'remote') {
    // Remote agents cannot reach the compose-internal forge hostname. They use the
    // externally reachable clone URL; `repoSpecForRun` falls back to the same URL.
    return config.runnerRepoUrl
      ? { url: config.runnerRepoUrl }
      : { path: process.env.REPO_ROOT ?? process.cwd() };
  }
  const repository = definition.manifest.repositories[0];
  const forgejo = process.env.FORGEJO_URL ?? 'http://forgejo:3000';
  if (repository) {
    return { url: `${forgejo.replace(/\/+$/, '')}/${repository.owner}/${repository.name}.git` };
  }
  return { path: process.env.REPO_ROOT ?? process.cwd() };
}

function validationPrompt(args: {
  mission: Mission;
  milestone: MissionMilestone;
  plan: MissionPlanData;
  kind: MissionValidationKind;
  round: number;
  assertions: MissionPlanData['validationContract']['assertions'];
  previousFindings: Record<string, unknown>[];
}): string {
  const { mission, milestone, kind, round, assertions, previousFindings } = args;
  const instruction =
    kind === 'user-testing'
      ? 'Start the application and exercise the assertions in a real browser (Playwright or agent-browser). Do not edit source files.'
      : 'Inspect the repository, run the build/lint/typecheck/tests and review the diff. Do not edit source files.';

  return [
    `Fresh mission validator (${kind}, round ${round}).`,
    `Mission: ${mission.title}`,
    `Goal:\n${mission.goal}`,
    `Milestone: ${milestone.title}`,
    milestone.description,
    '',
    instruction,
    '',
    'Validation contract assertions:',
    ...assertions.map(
      (assertion) =>
        `- [${assertion.id}] ${assertion.title}: ${assertion.assertion} (tool: ${assertion.tool}, evidence: ${assertion.evidence}${assertion.command ? `, command: ${assertion.command}` : ''})`,
    ),
    ...(previousFindings.length > 0
      ? ['', `Previous failed findings:\n${JSON.stringify(previousFindings)}`]
      : []),
    '',
    'Report every assertion by id. Finish with exactly one fenced JSON block:',
    '```json',
    '{"validation":[{"id":"<assertion id>","status":"pass|fail","evidence":"<command output/screenshot>"}]}',
    '```',
    'Report "fail" when an assertion did not pass; never omit an assertion you exercised.',
  ].join('\n');
}

/* ------------------------------------------------------------------ state */

export interface MissionStateSnapshot {
  mission: Mission;
  plan: MissionPlanData | null;
  milestones: MissionMilestone[];
  features: MissionFeature[];
  featureStatuses: Record<string, MissionFeatureStatus>;
  checkpoints: MissionCheckpoint[];
  cancelRequested: boolean;
  cancelActor: string | null;
  cancelReason: string | null;
  pendingGate: MissionGate | null;
}

export async function loadMissionStateActivity(args: {
  missionId: string;
}): Promise<MissionStateSnapshot> {
  const sql = getSql();
  const mission = await getMission(sql, args.missionId);
  if (!mission) throw missionNotFound(args.missionId);

  const [milestones, features, checkpoints, pendingGate, cancel] = await Promise.all([
    listMissionMilestones(sql, args.missionId),
    listMissionFeatures(sql, args.missionId),
    listMissionCheckpoints(sql, args.missionId),
    getPendingMissionGate(sql, args.missionId),
    // Cancellation is read from the row, not only from the Signal (ADR-013 pattern).
    readMissionCancel(sql, args.missionId),
  ]);

  const featureStatuses: Record<string, MissionFeatureStatus> = {};
  for (const feature of features) featureStatuses[feature.id] = feature.status;

  return {
    mission,
    plan: asPlan(mission.plan),
    milestones,
    features,
    featureStatuses,
    checkpoints,
    cancelRequested: cancel.requested,
    cancelActor: cancel.actor,
    cancelReason: cancel.reason,
    pendingGate,
  };
}

/* ---------------------------------------------------------------- planning */

export async function planMissionActivity(args: {
  missionId: string;
  factory: string;
  definitionCommit: string;
  title: string;
  goal: string;
  feedback?: string;
  createdAt?: string;
}): Promise<MissionPlanData> {
  const planner = getMissionPlanner();
  const plan = await planner.plan(args);
  // The workflow may not import zod; validation stays here, at the activity boundary.
  const validation = validateMissionPlan(plan);
  if (!validation.plan) throw invalidPlan(validation.errors);
  return validation.plan as MissionPlanData;
}

export async function persistMissionPlanActivity(args: {
  missionId: string;
  plan: MissionPlanData;
  planVersion: number;
}): Promise<void> {
  await persistMissionPlan(getSql(), args.missionId, args.plan as MissionPlan, args.planVersion);
}

export async function createMissionPlanGateActivity(args: {
  missionId: string;
  planVersion: number;
  workflowId: string;
}): Promise<MissionGate> {
  const config = loadConfig();
  return await createMissionGate(getSql(), {
    missionId: args.missionId,
    gate: 'plan',
    attempt: args.planVersion,
    workflowId: args.workflowId,
    slaAt: new Date(Date.now() + config.gateSlaMs).toISOString(),
  });
}

/* --------------------------------------------------------------- features */

export interface CreatedMissionFeatureWorkItem {
  workItemId: string;
  input: FactoryWorkflowInput;
}

export async function createMissionFeatureWorkItemActivity(args: {
  missionId: string;
  featureId: string;
}): Promise<CreatedMissionFeatureWorkItem> {
  const sql = getSql();
  const mission = await getMission(sql, args.missionId);
  if (!mission) throw missionNotFound(args.missionId);

  const plan = asPlan(mission.plan);
  if (!plan) throw invalidPlan(['mission has no persisted plan']);

  const features = await listMissionFeatures(sql, args.missionId);
  const feature = features.find((entry) => entry.id === args.featureId);
  if (!feature) {
    throw ApplicationFailure.create({
      type: 'mission_feature_not_found',
      nonRetryable: true,
      message: `mission feature ${args.featureId} does not exist`,
      details: [{ missionId: args.missionId, featureId: args.featureId }],
    });
  }

  const milestones = await listMissionMilestones(sql, args.missionId);
  const milestone =
    milestones.find((entry) => entry.id === feature.milestoneId) ?? null;
  if (!milestone) {
    throw ApplicationFailure.create({
      type: 'mission_milestone_not_found',
      nonRetryable: true,
      message: `mission milestone ${feature.milestoneId} does not exist`,
      details: [{ missionId: args.missionId, milestoneId: feature.milestoneId }],
    });
  }

  const checkpoints = await listMissionCheckpoints(sql, args.missionId);
  const prompt = featurePrompt({ mission, plan, milestone, feature, checkpoints });
  const loop = compileMissionLoop(mission, prompt);

  const implementIndex = loop.stageGraph.order.indexOf('implement');
  if (implementIndex < 0) {
    throw ApplicationFailure.create({
      type: 'mission_stage_missing',
      nonRetryable: true,
      message: `factory "${mission.factory}" has no implement stage`,
      details: [{ factory: mission.factory, order: loop.stageGraph.order }],
    });
  }

  const override = harnessOverride();
  const harness = override ?? defaultHarness(loop.definition);
  const model = resolveModel(
    loop.definition.manifest.agentDefaults.model ??
      loop.definition.manifest.agentDefaults.harness?.model ??
      null,
    harness,
  );
  const runner = override === 'fake' ? 'fake' : mapRunner(loop.definition.manifest.agentDefaults.runner);

  const autonomy = await getAutonomyState(sql, mission.factory);
  const gateResolution = resolveAllGates(loop.definition.manifest);
  const benchmarkGateSatisfied =
    !gateResolution.benchmarkGateRequired ||
    Boolean(autonomy?.overrideActor && autonomy?.overrideReason);

  // Reuse a live work item (activity retry); a terminal one cannot drive the feature
  // again, so a pause/resume dispatch creates a fresh item.
  let workItemId = feature.workItemId;
  let existingWorkItem = workItemId ? await getWorkItem(sql, workItemId) : null;
  if (!existingWorkItem || existingWorkItem.status !== 'active') {
    // A retried activity may have created the item before the feature link landed; a
    // paused feature points at a cancelled item, so a fresh one is created instead.
    const live = (await listMissionWorkItems(sql, mission.id)).find(
      (item) => item.missionFeatureId === feature.id && item.status === 'active',
    );
    existingWorkItem = live ?? null;
    workItemId = live?.id ?? null;
  }
  workItemId = workItemId ?? newWorkItemId();
  const workflowId = workItemWorkflowId(workItemId);

  const input: FactoryWorkflowInput = {
    workItemId,
    missionId: mission.id,
    factory: mission.factory,
    ...(mission.factoryId ? { factoryId: mission.factoryId } : {}),
    factoryRoot: mission.factoryRoot,
    definitionCommit: mission.definitionCommit,
    definitionDirty: mission.definitionDirty,
    title: `${mission.title}: ${feature.title}`,
    prompt,
    sourceRef: {
      kind: 'mission',
      missionId: mission.id,
      missionFeatureId: feature.id,
      milestoneId: milestone.id,
      goal: mission.goal,
    },
    // Mission features implement against the integrated forge repository, so the captured
    // patch applies to the same tree the PR targets. The central factory checkout is only
    // the definition source.
    repo: validationRepo(loop.definition, runner),
    stageGraph: loop.stageGraph,
    gates: loop.gates,
    agentVerdict: loop.definition.manifest.agentVerdict,
    mergePolicy: loop.definition.manifest.mergePolicy,
    autonomy: {
      enabled: autonomy?.enabled ?? false,
      paused: autonomy?.paused ?? false,
      benchmarkGateSatisfied,
      actor: autonomy?.actor ?? null,
      reason: autonomy?.reason ?? null,
    },
    loopLimit: loadConfig().loopLimit,
    gateSlaMs: loadConfig().gateSlaMs,
    maxStagesPerRun: loadConfig().maxStagesPerRun,
    defaultHarness: harness,
    ...(override ? { harnessOverride: override } : {}),
    ...(model ? { defaultModel: model } : {}),
    defaultRunner: runner,
    ...(override ? { runnerOverride: runner } : {}),
    autoAllowPermissions: true,
    permissionTimeoutMs: loadConfig().permissionTimeoutMs,
    ...(loop.definition.manifest.budget ? { budget: loop.definition.manifest.budget } : {}),
    ...(loop.definition.manifest.governance
      ? { governance: loop.definition.manifest.governance }
      : {}),
    resume: {
      stageIndex: implementIndex,
      loopCount: 0,
      stagesCompleted: 0,
      attempts: {},
      currentStage: 'implement',
    },
  };

  if (!existingWorkItem) {
    await createWorkItem(sql, {
      id: workItemId,
      factory: mission.factory,
      ...(mission.factoryId ? { factoryId: mission.factoryId } : {}),
      // The core feature row does not carry `work_item_type`; fix features are bugs.
      type: (feature.fixForFeatureId ? 'bug' : 'task') as WorkItemType,
      source: 'mission',
      sourceRef: input.sourceRef,
      title: input.title,
      stage: 'implement',
      definitionCommit: mission.definitionCommit,
      definitionDirty: mission.definitionDirty,
      canaryRolloutId: mission.canaryRolloutId,
      definitionVersion: mission.definitionVersion,
      workflowId,
      input: {
        stageGraph: loop.stageGraph.order,
        gates: loop.gates,
        mergePolicy: loop.definition.manifest.mergePolicy,
        prompt,
        harness,
        ...(model ? { model } : {}),
        runner,
        missionId: mission.id,
        missionFeatureId: feature.id,
      },
      missionId: mission.id,
      missionFeatureId: feature.id,
      createdBy: mission.createdBy,
    });
  }

  await setMissionFeatureStatus(sql, {
    featureId: feature.id,
    status: 'running',
    workItemId,
  });

  return { workItemId, input };
}

/* ------------------------------------------------------------- checkpoints */

export async function recordMissionCheckpointActivity(args: {
  missionId: string;
  kind: string;
  state: Record<string, unknown>;
  milestoneId?: string | null;
  featureId?: string | null;
  dedupeKey?: string | null;
}): Promise<MissionCheckpoint> {
  return await recordMissionCheckpoint(getSql(), args);
}

export async function setMissionStatusActivity(args: {
  missionId: string;
  status: Mission['status'];
  error?: string | null;
  currentMilestoneId?: string | null;
  currentFeatureId?: string | null;
  workflowId?: string | null;
  attempt?: number;
}): Promise<Mission | null> {
  return await updateMissionStatus(getSql(), args);
}

export async function setMissionFeatureStatusActivity(args: {
  featureId: string;
  status: MissionFeatureStatus;
  workItemId?: string | null;
  attempt?: number;
}): Promise<MissionFeature | null> {
  return await setMissionFeatureStatus(getSql(), args);
}

export async function setMissionMilestoneStatusActivity(args: {
  milestoneId: string;
  status: MissionMilestoneStatus;
  validationRound?: number;
}): Promise<MissionMilestone | null> {
  return await setMissionMilestoneStatus(getSql(), args);
}

export async function appendMissionEventActivity(args: {
  missionId: string;
  type: string;
  milestoneId?: string | null;
  featureId?: string | null;
  actor?: string | null;
  payload?: Record<string, unknown>;
  dedupeKey?: string | null;
}): Promise<void> {
  await appendMissionEvent(getSql(), args);
}

/* ------------------------------------------------------------- validation */

export interface PreparedMissionValidation {
  input: RunInput;
  validationId: string;
}

export async function prepareMissionValidationActivity(args: {
  missionId: string;
  milestoneId: string;
  round: number;
  kind: MissionValidationKind;
  /** Distinct run id per pause/resume attempt; defaults to the logical round. */
  attempt?: number;
}): Promise<PreparedMissionValidation> {
  const sql = getSql();
  const mission = await getMission(sql, args.missionId);
  if (!mission) throw missionNotFound(args.missionId);

  const plan = asPlan(mission.plan);
  if (!plan) throw invalidPlan(['mission has no persisted plan']);

  const milestones = await listMissionMilestones(sql, args.missionId);
  const milestone = milestones.find((entry) => entry.id === args.milestoneId);
  if (!milestone) {
    throw ApplicationFailure.create({
      type: 'mission_milestone_not_found',
      nonRetryable: true,
      message: `mission milestone ${args.milestoneId} does not exist`,
      details: [{ missionId: args.missionId, milestoneId: args.milestoneId }],
    });
  }

  const assertions = assertionsForKind(plan, args.milestoneId, args.kind);

  const previous = (await listMissionValidations(sql, args.missionId))
    .filter(
      (validation) =>
        validation.milestoneId === args.milestoneId &&
        validation.kind === args.kind &&
        validation.status === 'failed',
    )
    .at(-1);
  const previousFindings = previous?.findings ?? [];

  const { definition, errors } = loadDefinition(mission.factoryRoot);
  if (!definition) throw definitionFailure(mission.factory, errors);

  const agents = definition.resources
    .filter((resource) => resource.kind === 'agent')
    .map((resource) => ({ name: resource.name, doc: resource.doc as AgentDef }));

  // Scrutiny uses the factory's review agent; user-testing uses the verify/QA agent.
  const preferredRole = args.kind === 'scrutiny' ? 'review' : 'verify';
  const agent =
    agents.find((entry) => entry.doc.role === preferredRole) ??
    agents.find((entry) => entry.doc.role === 'review') ??
    null;

  const override = harnessOverride();
  const harness =
    override ??
    ((agent?.doc.harness?.type ??
      definition.manifest.agentDefaults.harness?.type ??
      'opencode') as HarnessId);
  const model = resolveModel(
    agent?.doc.model ??
      agent?.doc.harness?.model ??
      definition.manifest.agentDefaults.model ??
      definition.manifest.agentDefaults.harness?.model ??
      null,
    harness,
  );
  const runner =
    override === 'fake'
      ? 'fake'
      : mapRunner(agent?.doc.runner ?? definition.manifest.agentDefaults.runner);

  // `missionValidationRunId` is deterministic per milestone/round/kind; a pause/resume
  // attempt appends a suffix so a closed Temporal child workflow id is never reused.
  const baseRunId = missionValidationRunId(
    mission.id,
    args.milestoneId,
    args.round,
    args.kind,
  );
  const runId =
    args.attempt !== undefined && args.attempt > 0
      ? `${baseRunId}_a${args.attempt}`
      : baseRunId;

  const existing = (await listMissionValidations(sql, args.missionId)).find(
    (validation) => validation.runId === runId && validation.kind === args.kind,
  );
  const validationId = existing?.id ?? newMissionValidationId();

  if (!existing) {
    await createMissionValidation(sql, {
      id: validationId,
      missionId: mission.id,
      milestoneId: args.milestoneId,
      round: args.round,
      kind: args.kind,
      runId,
      status: 'running',
    });
  }

  const input: RunInput = {
    runId,
    factory: mission.factory,
    ...(mission.factoryId ? { factoryId: mission.factoryId } : {}),
    factoryRoot: mission.factoryRoot,
    definitionCommit: mission.definitionCommit,
    definitionDirty: mission.definitionDirty,
    harness,
    ...(model ? { model } : {}),
    ...(agent ? { agent: agent.name } : {}),
    runner,
    repo: validationRepo(definition, runner),
    // Fresh validators need tools (package installs, a browser); the runner's own
    // isolation is still the boundary.
    networkPolicy: 'allowed',
    prompt: {
      text: validationPrompt({
        mission,
        milestone,
        plan,
        kind: args.kind,
        round: args.round,
        assertions,
        previousFindings,
      }),
    },
    kind: 'run',
    title: `${args.kind}: ${milestone.title} (round ${args.round})`,
    proxyModels: model ? [model] : [],
    autoAllowPermissions: true,
    missionId: mission.id,
  };

  await insertRun({
    runId,
    factory: mission.factory,
    ...(mission.factoryId ? { factoryId: mission.factoryId } : {}),
    definitionCommit: mission.definitionCommit,
    definitionDirty: mission.definitionDirty,
    harness,
    model: model ?? null,
    runner,
    kind: 'run',
    title: input.title ?? null,
    input,
    workflowId: runWorkflowIdFor(runId),
    missionId: mission.id,
  });

  return { input, validationId };
}

/** Marks an interrupted validation run as `error` so the read model has no stale `running`. */
export async function abortMissionValidationActivity(args: {
  validationId: string;
  reason: string;
}): Promise<void> {
  await updateMissionValidation(getSql(), {
    id: args.validationId,
    status: 'error',
    verdict: 'needs_human',
    findings: [{ status: 'error', detail: args.reason }],
    evidence: [],
  });
}

export interface MissionValidationCompletion {
  passed: boolean;
  findings: Record<string, unknown>[];
  evidence: Record<string, unknown>[];
  missing: string[];
}

export async function completeMissionValidationActivity(args: {
  missionId: string;
  milestoneId: string;
  validationId: string;
  runId: string;
  round: number;
  kind: MissionValidationKind;
}): Promise<MissionValidationCompletion> {
  const sql = getSql();
  const mission = await getMission(sql, args.missionId);
  if (!mission) throw missionNotFound(args.missionId);

  const plan = asPlan(mission.plan);
  if (!plan) throw invalidPlan(['mission has no persisted plan']);

  const run = await getRun(args.runId);
  if (!run) {
    throw ApplicationFailure.create({
      type: 'mission_validation_run_not_found',
      nonRetryable: true,
      message: `validation run ${args.runId} does not exist`,
      details: [{ runId: args.runId }],
    });
  }

  const assertions = assertionsForKind(plan, args.milestoneId, args.kind);
  const evidence = parseValidationEvidence(run.summary ?? '');
  const byId = new Map(evidence.map((entry) => [entry.checkId, entry]));

  const findings: Record<string, unknown>[] = [];
  const missing: string[] = [];

  if (run.status !== 'ok') {
    findings.push({
      assertionId: '__run__',
      title: 'validation run',
      status: 'fail',
      required: true,
      detail: `run ended ${run.status}: ${run.error ?? run.summary ?? 'no summary'}`,
    });
  }

  for (const assertion of assertions) {
    const entry = byId.get(assertion.id);
    const status = entry?.status ?? 'missing';
    if (assertion.required && status !== 'pass') {
      missing.push(assertion.id);
      findings.push({
        assertionId: assertion.id,
        title: assertion.title,
        assertion: assertion.assertion,
        status,
        required: true,
        detail:
          entry?.detail ??
          (status === 'missing'
            ? 'no evidence was reported for this assertion'
            : 'the validator reported a failure'),
        tool: assertion.tool,
        evidence: assertion.evidence,
      });
    }
  }

  const passed = run.status === 'ok' && missing.length === 0;
  await updateMissionValidation(sql, {
    id: args.validationId,
    status: passed ? 'passed' : 'failed',
    verdict: passed ? 'approve' : 'reject',
    findings,
    evidence: evidence as unknown as Record<string, unknown>[],
  });

  await appendMissionEvent(sql, {
    missionId: mission.id,
    type: passed ? 'mission.validation.passed' : 'mission.validation.failed',
    milestoneId: args.milestoneId,
    actor: args.kind,
    payload: {
      validationId: args.validationId,
      runId: args.runId,
      round: args.round,
      kind: args.kind,
      missing,
      findings: findings.length,
    },
    dedupeKey: `validation:${args.validationId}`,
  });

  return {
    passed,
    findings,
    evidence: evidence as unknown as Record<string, unknown>[],
    missing,
  };
}

/* ---------------------------------------------------------------- fix loop */

export interface PlannedFixFeatures {
  plan: MissionPlanData;
  features: MissionFeature[];
}

/**
 * Deterministic fix features: one per failed required assertion, linked to the feature
 * that claimed it, in the same milestone and with no dependencies. The plan JSON is
 * updated so a `continueAsNew` resumes with the fix features in scope.
 */
export async function planFixFeaturesActivity(args: {
  missionId: string;
  milestoneId: string;
  round: number;
  findings: Record<string, unknown>[];
  planVersion: number;
}): Promise<PlannedFixFeatures> {
  const sql = getSql();
  const mission = await getMission(sql, args.missionId);
  if (!mission) throw missionNotFound(args.missionId);

  const plan = asPlan(mission.plan);
  if (!plan) throw invalidPlan(['mission has no persisted plan']);

  const milestone = plan.milestones.find((entry) => entry.id === args.milestoneId);
  if (!milestone) {
    throw ApplicationFailure.create({
      type: 'mission_milestone_not_found',
      nonRetryable: true,
      message: `mission milestone ${args.milestoneId} is not part of the plan`,
      details: [{ missionId: args.missionId, milestoneId: args.milestoneId }],
    });
  }

  const dbFeatures = await listMissionFeatures(sql, args.missionId);
  const milestoneDbFeatures = dbFeatures.filter(
    (feature) => feature.milestoneId === args.milestoneId,
  );
  let nextOrdinal =
    milestoneDbFeatures.reduce((max, feature) => Math.max(max, feature.ordinal), -1) + 1;

  const failed = args.findings.filter(
    (finding) =>
      typeof finding.assertionId === 'string' &&
      finding.assertionId !== '__run__' &&
      finding.required !== false &&
      finding.status !== 'pass',
  );

  const created: MissionFeature[] = [];
  const planFeatures: MissionFeaturePlan[] = [];
  const seen = new Set<string>();

  for (const finding of failed) {
    const assertionId = finding.assertionId as string;
    if (seen.has(assertionId)) continue;
    seen.add(assertionId);

    const assertion = plan.validationContract.assertions.find(
      (entry) => entry.id === assertionId,
    );
    if (!assertion) continue;

    // Idempotent: an identical fix already exists for this assertion.
    const existing = milestoneDbFeatures.find(
      (feature) =>
        feature.fixForFeatureId !== null && feature.acceptanceCheckIds.includes(assertionId),
    );
    if (existing) continue;

    const failedFeatureId =
      typeof finding.featureId === 'string'
        ? finding.featureId
        : (milestoneDbFeatures.find((feature) =>
            feature.acceptanceCheckIds.includes(assertionId),
          )?.id ?? milestoneDbFeatures[0]?.id ?? null);

    const id = newMissionFeatureId();
    const title = `Fix: ${assertion.title}`;
    const description = [
      `Fix failed required assertion ${assertion.id}: ${assertion.assertion}`,
      '',
      `Finding: ${typeof finding.detail === 'string' ? finding.detail : 'no evidence was reported'}`,
      '',
      'Implement only the fix needed to satisfy this assertion.',
    ].join('\n');

    const feature = await createMissionFeature(sql, {
      id,
      missionId: mission.id,
      milestoneId: args.milestoneId,
      ordinal: nextOrdinal,
      title,
      description,
      status: 'pending',
      dependsOn: [],
      acceptanceCheckIds: [assertion.id],
      workItemType: 'bug',
      fixForFeatureId: failedFeatureId,
      attempt: args.round,
    });
    nextOrdinal += 1;
    created.push(feature);

    planFeatures.push({
      id,
      title,
      description,
      order: feature.ordinal,
      dependsOn: [],
      acceptanceCheckIds: [assertion.id],
      workItemType: 'bug',
    });

    await appendMissionEvent(sql, {
      missionId: mission.id,
      type: 'mission.fix_feature.created',
      milestoneId: args.milestoneId,
      featureId: id,
      actor: 'orchestrator',
      payload: {
        assertionId,
        failedFeatureId,
        round: args.round,
        title,
      },
      dedupeKey: `fix:${id}`,
    });
  }

  const updatedPlan: MissionPlan = {
    ...plan,
    milestones: plan.milestones.map((entry) =>
      entry.id === args.milestoneId
        ? { ...entry, features: [...entry.features, ...planFeatures] }
        : entry,
    ),
  };
  if (planFeatures.length > 0) {
    await setMissionPlan(sql, mission.id, updatedPlan, args.planVersion);
  }

  return { plan: updatedPlan as MissionPlanData, features: created };
}

/* ------------------------------------------------------------------ budget */

export interface MissionBudgetCheck {
  exceeded: boolean;
  reason: string | null;
  usage: { costUsd: number; runs: number; startedAt: string | null };
}

export async function missionBudgetCheckActivity(args: {
  missionId: string;
}): Promise<MissionBudgetCheck> {
  const sql = getSql();
  const mission = await getMission(sql, args.missionId);
  if (!mission) throw missionNotFound(args.missionId);
  const usage = await missionBudgetUsage(sql, args.missionId);
  const reason = missionBudgetExceeded(mission.budget, usage);
  return { exceeded: reason !== null, reason, usage };
}
