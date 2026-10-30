import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { SQL } from 'bun';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Worker } from '@temporalio/worker';
import {
  compileStageGraph,
  createWorkItem,
  foremanAgentName,
  getPendingGate,
  getWorkItem,
  listGateDecisions,
  listWorkItemEvents,
  loadOrThrow,
  newWorkItemId,
  requestWorkItemCancel,
  resolveStageConfigs,
  setAutonomyState,
  stageDeclarationsFromDefinition,
  type AgentDef,
  type LoopStage,
  type WorkItemStatus,
} from '@factory/core';
import { FakeForge } from '@factory/forge';
import { closeClient, getClient } from '../src/client';
import { closeSql, getSql, setSql } from '../src/db';
import { loadConfig, type OrchestrationConfig } from '../src/config';
import { setForge } from '../src/activities/forge';
import { clearEphemeralLeases } from '../src/activities/runner';
import { setReviewerModel } from '../src/models/review';
import { setJudgementModel } from '../src/models/judgement';
import { clearSessions } from '../src/sessions';
import { createWorker } from '../src/worker';
import {
  cancelWorkItem,
  pauseWorkItemAutonomy,
  startFactoryWorkflow,
  submitGateDecision,
} from '../src/factory-client';
import {
  workItemWorkflowId,
  type FactoryWorkflowInput,
  type LoopStageName,
  type StageNodeSummary,
} from '../src/types';

/**
 * Integration tests for the factory loop (Phase 3a).
 *
 * They need Temporal + Postgres, so they are opt-in (CI stays service-free):
 *
 *   docker compose up -d
 *   DATABASE_URL=postgres://factory:factory@localhost:5433/factory \
 *   TEMPORAL_ADDRESS=localhost:7233 RUN_INTEGRATION=1 \
 *   bun test packages/orchestration/test/factory-loop.integration.test.ts
 *
 * Everything runs on the fake forge + fake harness: no network, no credentials.
 */

const enabled =
  process.env.RUN_INTEGRATION === '1' &&
  Boolean(process.env.DATABASE_URL) &&
  Boolean(process.env.TEMPORAL_ADDRESS);

const suite = enabled ? describe : describe.skip;

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');
const FACTORY = 'example';
const FACTORY_ROOT = join(REPO_ROOT, 'factories', FACTORY);
const MIGRATIONS = join(REPO_ROOT, 'packages', 'core', 'migrations');
const REPO = { owner: 'acme', name: 'api-service' };

let config: OrchestrationConfig;
let worker: Worker;
let running: Promise<void>;
let runsDir: string;
let forge: FakeForge;
/** First Temporal run id per work item, for the continueAsNew assertion. */
const startedRuns = new Map<string, string>();

async function migrate(databaseUrl: string): Promise<void> {
  const sql = new SQL(databaseUrl, { max: 1 });
  try {
    // Mirrors `scripts/migrate.ts`: apply each file once (recorded in schema_migrations).
    // Re-running every file against a dirty database would recreate indexes over data
    // that violates them (the compose database is shared across suites).
    await sql`create table if not exists schema_migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    )`;
    const applied = new Set(
      ((await sql`select name from schema_migrations`) as { name: string }[]).map((row) => row.name),
    );
    const files = (await readdir(MIGRATIONS)).filter((file) => file.endsWith('.sql')).sort();
    for (const file of files) {
      if (applied.has(file)) continue;
      await sql.unsafe(await readFile(join(MIGRATIONS, file), 'utf8'));
      await sql`insert into schema_migrations (name) values (${file}) on conflict do nothing`;
    }
  } finally {
    await sql.close();
  }
}

async function waitFor<T>(
  label: string,
  probe: () => Promise<T | null | undefined | false>,
  timeoutMs = 45_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
}

/** Mirrors what the API does: compile the definition graph, resolve stages, start. */
function buildInput(
  workItemId: string,
  overrides: Partial<FactoryWorkflowInput> = {},
): FactoryWorkflowInput {
  const definition = loadOrThrow(FACTORY_ROOT);
  const agents = definition.resources
    .filter((resource) => resource.kind === 'agent')
    .map((resource) => ({ name: resource.name, doc: resource.doc as AgentDef }));

  const graph = compileStageGraph(stageDeclarationsFromDefinition(definition.manifest, agents));
  const configs = resolveStageConfigs(graph, {
    manifest: definition.manifest,
    agents,
    spawner: foremanAgentName(agents),
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
    workItemId,
    factory: FACTORY,
    factoryRoot: FACTORY_ROOT,
    definitionCommit: 'itest',
    definitionDirty: false,
    title: 'Add retry to the API client',
    prompt: 'Add retry to the API client',
    sourceRef: { kind: 'issue', id: '123', url: 'https://forge.local/acme/api-service/issues/123' },
    repo: { path: REPO_ROOT },
    stageGraph: { order: [...graph.order], fanOut: { ...graph.fanOut }, nodes },
    gates,
    mergePolicy: definition.manifest.mergePolicy,
    autonomy: { enabled: false, paused: false, benchmarkGateSatisfied: false },
    loopLimit: 3,
    gateSlaMs: 60_000,
    maxStagesPerRun: 10,
    defaultHarness: 'fake',
    harnessOverride: 'fake',
    defaultModel: 'fake/fake-model',
    defaultRunner: 'fake',
    autoAllowPermissions: true,
    permissionTimeoutMs: 30_000,
    ...overrides,
  };
}

async function newItem(overrides: Partial<FactoryWorkflowInput> = {}): Promise<string> {
  const workItemId = newWorkItemId();
  // The kill-switch test persists `paused` in the read model; reset it per item so tests
  // do not depend on execution order.
  await setAutonomyState(getSql(), {
    factory: FACTORY,
    enabled: false,
    paused: false,
    actor: 'itest',
    reason: 'test reset',
    benchmarkGateRequired: false,
  });
  const input = buildInput(workItemId, overrides);
  await createWorkItem(getSql(), {
    id: workItemId,
    factory: FACTORY,
    type: 'task',
    source: 'manual',
    sourceRef: input.sourceRef,
    title: input.title,
    stage: input.stageGraph.order[0] as LoopStage,
    definitionCommit: input.definitionCommit,
    workflowId: workItemWorkflowId(workItemId),
    input: { stageGraph: input.stageGraph.order },
  });
  const started = await startFactoryWorkflow(input, config);
  startedRuns.set(workItemId, started.temporalRunId);
  return workItemId;
}

async function pendingGate(workItemId: string, stage: string) {
  return await waitFor(`a pending ${stage} gate on ${workItemId}`, async () =>
    await getPendingGate(getSql(), { workItemId, stage }),
  );
}

async function decide(
  workItemId: string,
  stage: LoopStageName,
  decision: 'approve' | 'reject' | 'request_changes',
  options: { feedback?: string; actor?: string } = {},
): Promise<void> {
  const gate = await pendingGate(workItemId, stage);
  expect(gate.workflowId).toBeTruthy();
  const delivery = await submitGateDecision(
    {
      workflowId: gate.workflowId as string,
      stage,
      decision,
      actor: options.actor ?? 'ada',
      ...(options.feedback ? { feedback: options.feedback } : {}),
      attempt: gate.attempt,
    },
    config,
  );
  expect(delivery.accepted).toBe(true);
}

async function waitForStatus(workItemId: string, status: WorkItemStatus): Promise<void> {
  await waitFor(`work item ${workItemId} to reach ${status}`, async () => {
    const item = await getWorkItem(getSql(), workItemId);
    return item?.status === status ? true : false;
  });
}

suite('factory loop on the fake forge + fake harness', () => {
  beforeAll(async () => {
    runsDir = await mkdtemp(join(tmpdir(), 'factory-loop-itest-'));
    process.env.RUNS_DIR = runsDir;
    await migrate(process.env.DATABASE_URL as string);
    setSql(getSql(process.env.DATABASE_URL));

    config = {
      ...loadConfig(),
      taskQueue: `factory-loop-itest-${process.pid}-${Date.now()}`,
      runsDir,
      maxConcurrentActivityTaskExecutions: 12,
      maxConcurrentWorkflowTaskExecutions: 12,
    };

    forge = new FakeForge();
    setForge('fake', forge);

    clearSessions();
    clearEphemeralLeases();
    worker = await createWorker(config);
    running = worker.run();
  }, 90_000);

  afterAll(async () => {
    worker?.shutdown();
    await running?.catch(() => undefined);
    clearSessions();
    clearEphemeralLeases();
    setForge('fake', null);
    setJudgementModel(null);
    setReviewerModel(null);
    // The kill-switch test pauses the shared factory; restore it for smoke/E2E.
    await setAutonomyState(getSql(), {
      factory: FACTORY,
      enabled: false,
      paused: false,
      actor: 'itest',
      reason: 'integration cleanup',
      benchmarkGateRequired: false,
    }).catch(() => undefined);
    await closeSql();
    await closeClient();
  }, 90_000);

  test('create → triage → spec → implement → review (2 reviewers) → verify → ship', async () => {
    setJudgementModel(null);
    setReviewerModel(null);

    const workItemId = await newItem({ gateSlaMs: 60_000 });

    await decide(workItemId, 'triage', 'approve');
    await decide(workItemId, 'spec', 'approve');
    await decide(workItemId, 'ship', 'approve');

    await waitForStatus(workItemId, 'done');
    const item = await getWorkItem(getSql(), workItemId);
    expect(item?.stage).toBe('ship');
    expect(item?.prUrl).toBeTruthy();
    expect(item?.prNumber).toBeTruthy();

    const gates = await listGateDecisions(getSql(), workItemId);
    const byStage = Object.fromEntries(gates.map((gate) => [gate.stage, gate]));
    expect(byStage.triage).toMatchObject({ decision: 'approve', actor: 'ada', automatic: false });
    expect(byStage.spec).toMatchObject({ decision: 'approve', actor: 'ada', automatic: false });
    expect(byStage.implement).toMatchObject({ decision: 'approve', automatic: true });
    expect(byStage.review).toMatchObject({ decision: 'approve', automatic: true });
    expect(byStage.verify).toMatchObject({ decision: 'approve', automatic: true });
    expect(byStage.ship).toMatchObject({ decision: 'approve', actor: 'ada', automatic: false });

    const events = await listWorkItemEvents(getSql(), workItemId);
    const types = events.map((event) => event.type);
    expect(types.filter((type) => type === 'stage.changed')).toHaveLength(5);
    expect(types).toContain('pr.opened');
    expect(types).toContain('checks.recorded');

    const reviewVerdicts = events.filter(
      (event) => event.type === 'review.verdict' && event.actor === 'judge',
    );
    expect(reviewVerdicts).toHaveLength(1);
    expect(reviewVerdicts[0]?.payload).toMatchObject({
      verdict: 'approve',
      reviewers: 2,
      advisory: true,
    });

    // Reviewer children are independent runs on the same commit.
    const reviewerEvents = events.filter(
      (event) => event.type === 'review.verdict' && (event.actor ?? '').startsWith('reviewer-'),
    );
    expect(reviewerEvents).toHaveLength(2);

    // The forge merged the PR; nothing was approved or merged on a verdict alone.
    const pulls = forge.listPullRequests(REPO);
    const pull = pulls.find((candidate) => candidate.workItemId === workItemId);
    expect(pull?.state).toBe('merged');
  }, 180_000);

  test('continueAsNew bounds history on a long loop and resumes the stage index', async () => {
    setJudgementModel(null);
    setReviewerModel(null);

    const workItemId = await newItem({ gateSlaMs: 60_000, maxStagesPerRun: 2 });

    await decide(workItemId, 'triage', 'approve');
    await decide(workItemId, 'spec', 'approve');
    await decide(workItemId, 'ship', 'approve');

    await waitForStatus(workItemId, 'done');
    const item = await getWorkItem(getSql(), workItemId);
    expect(item?.prUrl).toBeTruthy();

    // A `continueAsNew` replaces the Temporal run id; the workflow id is stable.
    const client = await getClient(config);
    const description = await client.workflow
      .getHandle(workItemWorkflowId(workItemId))
      .describe();
    expect(description.runId).not.toBe(startedRuns.get(workItemId));

    const events = await listWorkItemEvents(getSql(), workItemId);
    expect(events.filter((event) => event.type === 'stage.changed')).toHaveLength(5);
  }, 180_000);

  test('request_changes sends the item back one stage and escalates past the loop limit', async () => {
    setJudgementModel(null);
    setReviewerModel(null);

    const workItemId = await newItem({ gateSlaMs: 60_000, loopLimit: 1 });

    await decide(workItemId, 'triage', 'approve');
    await decide(workItemId, 'spec', 'request_changes', { feedback: 'add a regression test' });

    // Back to triage with the feedback attached and the loop counter incremented.
    await waitFor(`the item to return to triage`, async () => {
      const item = await getWorkItem(getSql(), workItemId);
      return item?.stage === 'triage' && item.loopCount === 1 ? true : false;
    });

    const firstEvents = await listWorkItemEvents(getSql(), workItemId);
    expect(firstEvents.some((event) => event.type === 'loop.requested_changes')).toBe(true);
    const back = firstEvents.find(
      (event) =>
        event.type === 'stage.changed' &&
        event.payload.from === 'spec' &&
        event.payload.to === 'triage',
    );
    expect(back?.payload.reason).toContain('add a regression test');

    await decide(workItemId, 'triage', 'approve');
    await decide(workItemId, 'spec', 'request_changes', { feedback: 'still missing tests' });

    await waitForStatus(workItemId, 'escalated');
    const item = await getWorkItem(getSql(), workItemId);
    expect(item?.loopCount).toBe(2);

    const events = await listWorkItemEvents(getSql(), workItemId);
    const escalated = events.find((event) => event.type === 'loop.escalated');
    expect(escalated?.payload).toMatchObject({ loopCount: 2, limit: 1 });
  }, 180_000);

  test('SLA fallback auto-rejects when lights are on', async () => {
    setJudgementModel(null);
    setReviewerModel(null);

    const workItemId = await newItem({ gateSlaMs: 400 });

    await pendingGate(workItemId, 'triage');
    await waitForStatus(workItemId, 'cancelled');

    const gates = await listGateDecisions(getSql(), workItemId);
    const triage = gates.find((gate) => gate.stage === 'triage');
    expect(triage).toMatchObject({ decision: 'reject', automatic: true, actor: 'system:sla' });

    const events = await listWorkItemEvents(getSql(), workItemId);
    expect(events.some((event) => event.type === 'gate.escalated')).toBe(true);
  }, 120_000);

  test('SLA fallback auto-approves only when the autonomy policy allows it', async () => {
    setJudgementModel(null);
    setReviewerModel(null);

    const workItemId = await newItem({
      gateSlaMs: 400,
      mergePolicy: 'auto_on_green',
      autonomy: { enabled: true, paused: false, benchmarkGateSatisfied: true },
    });

    await waitForStatus(workItemId, 'done');
    const item = await getWorkItem(getSql(), workItemId);
    expect(item?.prUrl).toBeTruthy();

    const gates = await listGateDecisions(getSql(), workItemId);
    const humanGates = gates.filter((gate) => gate.stage === 'triage' || gate.stage === 'spec' || gate.stage === 'ship');
    expect(humanGates).toHaveLength(3);
    for (const gate of humanGates) {
      expect(gate).toMatchObject({ decision: 'approve', automatic: true, actor: 'system:sla' });
    }

    const pull = forge.listPullRequests(REPO).find((candidate) => candidate.workItemId === workItemId);
    expect(pull?.state).toBe('merged');
  }, 180_000);

  test('kill switch: pausing autonomy stops dispatch and blocks the item', async () => {
    setJudgementModel(null);
    setReviewerModel(null);

    const workItemId = await newItem({ gateSlaMs: 60_000 });
    await pendingGate(workItemId, 'triage');

    await setAutonomyState(getSql(), {
      factory: FACTORY,
      enabled: false,
      paused: true,
      actor: 'grace',
      reason: 'incident 42',
    });

    await pauseWorkItemAutonomy(
      { workflowId: workItemWorkflowId(workItemId), actor: 'grace', reason: 'incident 42' },
      config,
    );

    await waitForStatus(workItemId, 'blocked');
    const events = await listWorkItemEvents(getSql(), workItemId);
    const paused = events.find((event) => event.type === 'autonomy.paused');
    expect(paused?.actor).toBe('grace');
    expect(paused?.payload.reason).toBe('incident 42');
  }, 120_000);

  test('cancel while gated cancels the stage child and ends cancelled (idempotent)', async () => {
    const workItemId = await newItem({ gateSlaMs: 60_000 });
    const gate = await pendingGate(workItemId, 'triage');
    expect(gate.workflowId).toBeTruthy();

    // The API records the request once, then Signals the workflow.
    const recorded = await requestWorkItemCancel(getSql(), {
      workItemId,
      actor: 'ada',
      reason: 'itest: cancel while gated',
      stage: 'triage',
    });
    expect(recorded.requested).toBe(true);

    const delivery = await cancelWorkItem(
      workItemWorkflowId(workItemId),
      { actor: 'ada', reason: 'itest: cancel while gated' },
      config,
    );
    expect(delivery.delivered).toBe(true);

    await waitForStatus(workItemId, 'cancelled');
    const item = await getWorkItem(getSql(), workItemId);
    expect(item?.cancelActor).toBe('ada');
    expect(item?.cancelReason).toBe('itest: cancel while gated');

    const events = await listWorkItemEvents(getSql(), workItemId);
    const cancelledEvents = events.filter((event) => event.type === 'work_item.cancelled');
    expect(cancelledEvents).toHaveLength(1);
    expect(cancelledEvents[0]?.payload.reason).toBe('itest: cancel while gated');
    expect(events.some((event) => event.type === 'cancel.requested')).toBe(true);

    // Repeat: a second request/signal is a no-op and emits no second terminal event.
    const repeat = await requestWorkItemCancel(getSql(), {
      workItemId,
      actor: 'grace',
      reason: 'itest: repeat cancel',
      stage: 'triage',
    });
    expect(repeat.alreadyRequested).toBe(true);
    expect(repeat.requested).toBe(false);
    await cancelWorkItem(workItemWorkflowId(workItemId), { actor: 'grace', reason: 'repeat' }, config);
    await new Promise<void>((resolve) => setTimeout(resolve, 500));

    const after = await listWorkItemEvents(getSql(), workItemId);
    expect(after.filter((event) => event.type === 'work_item.cancelled')).toHaveLength(1);
    expect((await getWorkItem(getSql(), workItemId))?.status).toBe('cancelled');
  }, 90_000);

  test('a recorded cancel is honoured even when the Signal is lost', async () => {
    const workItemId = await newItem({ gateSlaMs: 60_000 });
    await pendingGate(workItemId, 'triage');

    // Record the request without delivering the Signal, then let the gate approve. The
    // workflow re-reads the read model before the next dispatch and must cancel.
    await requestWorkItemCancel(getSql(), {
      workItemId,
      actor: 'ada',
      reason: 'itest: lost signal',
      stage: 'triage',
    });
    await decide(workItemId, 'triage', 'approve');

    await waitForStatus(workItemId, 'cancelled');
    const events = await listWorkItemEvents(getSql(), workItemId);
    expect(events.filter((event) => event.type === 'work_item.cancelled')).toHaveLength(1);
  }, 90_000);

  test('reviewer disagreement escalates to a human review gate and never merges on a verdict', async () => {
    setJudgementModel(null);
    setReviewerModel({
      id: 'scripted-disagreement',
      review: async (input) =>
        input.reviewerIndex === 1
          ? {
              verdict: 'approve',
              findings: [],
              confidence: 0.9,
            }
          : {
              verdict: 'reject',
              findings: [
                {
                  reviewer: `reviewer-${input.reviewerIndex}`,
                  severity: 'blocker',
                  summary: 'missing regression test',
                },
              ],
              confidence: 0.85,
            },
    });

    try {
      const workItemId = await newItem({ gateSlaMs: 60_000 });

      await decide(workItemId, 'triage', 'approve');
      await decide(workItemId, 'spec', 'approve');

      const reviewGate = await pendingGate(workItemId, 'review');
      expect(reviewGate.gate).toBe('human');

      const events = await listWorkItemEvents(getSql(), workItemId);
      const verdict = events.find(
        (event) => event.type === 'review.verdict' && event.actor === 'judge',
      );
      expect(verdict?.payload).toMatchObject({
        verdict: 'needs_human',
        reviewers: 2,
        advisory: true,
      });
      expect(Array.isArray(verdict?.payload.findings)).toBe(true);

      await decide(workItemId, 'review', 'approve');
      await decide(workItemId, 'ship', 'approve');

      await waitForStatus(workItemId, 'done');
      const item = await getWorkItem(getSql(), workItemId);
      expect(item?.prUrl).toBeTruthy();
    } finally {
      setReviewerModel(null);
    }
  }, 240_000);
});
