import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { SQL } from 'bun';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Worker } from '@temporalio/worker';
import {
  createProposal,
  getCanaryRollout,
  getProposal,
  listCanaryEvents,
  loadDefinition,
  loadOrThrow,
  recordScore,
  type CanaryRolloutRecord,
  type ProposalRecord,
} from '@factory/core';
import { composeCandidate } from '@factory/evals';
import { FakeForge } from '@factory/forge';
import { closeClient, getClient } from '../src/client';
import { closeSql, insertRun, setSql } from '../src/db';
import { loadConfig, type OrchestrationConfig } from '../src/config';
import { setForge } from '../src/activities/forge';
import { clearSessions } from '../src/sessions';
import { createWorker } from '../src/worker';
import {
  canaryCandidateRoot,
  rollbackCanaryRollout,
  startCanaryRollout,
} from '../src/canary-apply';
import { signalCanaryRollback } from '../src/canary-client';
import { canaryWorkflowId, type CanaryWorkflowOutcome } from '../src/types';

/**
 * Canary rollout integration (Phase 5b, ADR-021).
 *
 * Needs Temporal + Postgres:
 *
 *   docker compose up -d
 *   DATABASE_URL=postgres://factory:factory@localhost:5433/factory \
 *   TEMPORAL_ADDRESS=localhost:7233 RUN_INTEGRATION=1 \
 *   bun test packages/orchestration/test/canary.integration.test.ts
 *
 * A composed proposal → candidate version published on the fake forge → observation
 * window → promote (no regression), auto-rollback (pass-rate regression), manual rollback.
 * No model, no network, no credentials.
 */

const enabled =
  process.env.RUN_INTEGRATION === '1' &&
  Boolean(process.env.DATABASE_URL) &&
  Boolean(process.env.TEMPORAL_ADDRESS);

const suite = enabled ? describe : describe.skip;

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');
const EXAMPLE = join(REPO_ROOT, 'factories', 'example');
const FACTORY = 'canary-fixture';
const MIGRATIONS = join(REPO_ROOT, 'packages', 'core', 'migrations');
const STABLE_COMMIT = 'b'.repeat(40);

let config: OrchestrationConfig;
let worker: Worker;
let running: Promise<void>;
let factoryRoot: string;
let sql: SQL;
let forge: FakeForge;

async function migrate(databaseUrl: string): Promise<void> {
  const client = new SQL(databaseUrl, { max: 1 });
  try {
    const files = (await readdir(MIGRATIONS)).filter((file) => file.endsWith('.sql')).sort();
    for (const file of files) {
      await client.unsafe(await readFile(join(MIGRATIONS, file), 'utf8'));
    }
  } finally {
    await client.close();
  }
}

function uniqueId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

/** A composed proposal whose candidate edits `agents/implement/agent.md`. */
async function createComposedProposal(label: string): Promise<ProposalRecord> {
  const { definition } = loadDefinition(factoryRoot);
  expect(definition).toBeDefined();
  const files = composeCandidate(definition!, [
    {
      kind: 'invariant',
      path: 'agents/implement/agent.md',
      rationale: `canary fixture ${label}: add a scope reminder`,
      content: `${readFileSync(join(factoryRoot, 'agents', 'implement', 'agent.md'), 'utf8')}\n\nAlways re-read the work item scope before editing. (${label})\n`,
    },
  ]);
  const proposalId = uniqueId('prop_canary');
  return await createProposal(sql, {
    id: proposalId,
    factory: FACTORY,
    authority: 'canary',
    status: 'accepted',
    title: `Canary fixture ${label}`,
    summary: `canary integration fixture ${label}`,
    impact: 1.5,
    evidence: { runIds: [`run_fixture_${label}`], failedRuns: 2, totalRuns: 3, costUsd: 0.2 },
    failureSignature: `canary_fixture:${label}`,
    files: files.changedPaths,
    diff: files.diff,
    candidateHash: files.candidateHash,
    clusterKey: `canary:${label}`,
  });
}

/** Seeds one scored run pinned to a commit so the observation has evidence. */
async function seedScoredRun(args: {
  label: string;
  definitionCommit: string;
  passing: boolean;
  score: number;
  status?: 'ok' | 'error' | 'cancelled';
}): Promise<void> {
  const runId = uniqueId(`run_canary_${args.label}`);
  await insertRun({
    runId,
    factory: FACTORY,
    definitionCommit: args.definitionCommit,
    definitionDirty: false,
    harness: 'fake',
    model: 'fake/fake-model',
    runner: 'fake',
    kind: 'run',
    title: `canary fixture ${args.label}`,
    input: {
      runId,
      factory: FACTORY,
      factoryRoot,
      definitionCommit: args.definitionCommit,
      definitionDirty: false,
      harness: 'fake',
      runner: 'fake',
      prompt: { text: `canary fixture ${args.label}` },
      kind: 'run',
      proxyModels: [],
    },
    workflowId: `fixture-${runId}`,
  });
  await sql`
    update runs set status = ${args.status ?? 'ok'}, ended_at = now(), cost_usd = 0.1
    where id = ${runId}
  `;
  await recordScore(sql, {
    id: uniqueId('sc_canary'),
    factory: FACTORY,
    runId,
    workItemId: null,
    stage: 'implement',
    scorer: 'scope',
    scorerClass: 'deterministic',
    rubricHash: 'c'.repeat(64),
    status: args.status === 'error' ? 'error' : 'ok',
    label: args.passing ? 'compliant' : 'non_compliant',
    score: args.score,
    passing: args.passing,
    rationale: `canary fixture ${args.label}`,
    evidenceRefs: [`run:${runId}`],
    uncalibrated: false,
    provenance: { judgeModel: null, judgeModelVersion: null, costUsd: 0 },
  });
}

async function waitForActive(rolloutId: string, timeoutMs = 30_000): Promise<CanaryRolloutRecord> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rollout = await getCanaryRollout(sql, rolloutId);
    if (rollout && (rollout.status === 'active' || rollout.status === 'unavailable')) return rollout;
    if (Date.now() > deadline) {
      throw new Error(`rollout ${rolloutId} did not activate: ${rollout?.status ?? 'missing'}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function outcomeOf(workflowId: string): Promise<CanaryWorkflowOutcome> {
  const client = await getClient(config);
  return (await client.workflow.getHandle(workflowId).result()) as CanaryWorkflowOutcome;
}

suite('canary rollout on the fake forge', () => {
  beforeAll(async () => {
    factoryRoot = mkdtempSync(join(tmpdir(), 'factory-canary-def-'));
    cpSync(EXAMPLE, factoryRoot, { recursive: true });
    const manifestPath = join(factoryRoot, 'factory.yaml');
    writeFileSync(
      manifestPath,
      readFileSync(manifestPath, 'utf8').replace(/^name: example$/m, `name: ${FACTORY}`),
    );

    process.env.FACTORY_ROOT = join(factoryRoot, '..');
    process.env.RUNS_DIR = mkdtempSync(join(tmpdir(), 'factory-canary-runs-'));
    process.env.TEMPORAL_TASK_QUEUE = `factory-canary-itest-${process.pid}-${Date.now()}`;

    await migrate(process.env.DATABASE_URL as string);
    setSql(new SQL(process.env.DATABASE_URL as string, { max: 4 }));
    sql = new SQL(process.env.DATABASE_URL as string, { max: 4 });

    // The compose DB is shared across local runs: a stale in-flight rollout for this
    // fixture factory would (correctly) refuse a new one. Reset it.
    await sql`
      update canary_rollouts
      set status = 'rolled_back', reason = 'fixture reset', ended_at = coalesce(ended_at, now())
      where factory = ${FACTORY} and status in ('pending', 'active')
    `;

    config = {
      ...loadConfig(),
      taskQueue: process.env.TEMPORAL_TASK_QUEUE as string,
      runsDir: process.env.RUNS_DIR as string,
      maxConcurrentActivityTaskExecutions: 8,
      maxConcurrentWorkflowTaskExecutions: 8,
    };

    forge = new FakeForge();
    setForge('fake', forge);
    clearSessions();
    worker = await createWorker(config);
    running = worker.run();
  }, 120_000);

  afterAll(async () => {
    worker?.shutdown();
    await running?.catch(() => undefined);
    clearSessions();
    setForge('fake', null);
    await closeSql();
    await closeClient();
    await sql?.close();
    rmSync(factoryRoot, { recursive: true, force: true });
    rmSync(process.env.RUNS_DIR as string, { recursive: true, force: true });
  }, 90_000);

  test('publishes a candidate version and promotes it when there is no regression', async () => {
    const proposal = await createComposedProposal('promote');
    const started = await startCanaryRollout({
      factory: FACTORY,
      factoryRoot,
      definitionRepo: `factory/${FACTORY}`,
      baseBranch: 'main',
      proposal,
      stableCommit: STABLE_COMMIT,
      canaryPercent: 50,
      rollbackThreshold: 0.1,
      observationWindowHours: 1,
      observationWindowMs: 2_500,
      checkIntervalMs: 250,
      actor: 'itest',
      reason: 'promote fixture',
    });

    expect(started.rollout.status).toBe('pending');
    expect(started.rollout.candidateVersion).toMatch(/^factory-v\d+-candidate$/);
    expect(started.workflow).not.toBeNull();

    const active = await waitForActive(started.rollout.id);
    expect(active.status).toBe('active');
    expect(active.candidateCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(active.prUrl).toContain('pull');
    expect(active.canaryPercent).toBe(50);
    expect(existsSync(active.candidateRoot as string)).toBe(true);
    expect(active.candidateRoot).toBe(canaryCandidateRoot(started.rollout.id));
    expect((await getProposal(sql, proposal.id))?.status).toBe('canary');

    await seedScoredRun({ label: 'stable-pass', definitionCommit: STABLE_COMMIT, passing: true, score: 1 });
    await seedScoredRun({
      label: 'candidate-pass',
      definitionCommit: active.candidateCommit as string,
      passing: true,
      score: 1,
    });

    const outcome = await outcomeOf(canaryWorkflowId(started.rollout.id));
    expect(outcome.status).toBe('promoted');
    expect(outcome.reason).toContain('no regression');
    expect(outcome.promotedCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(outcome.observation?.stable.passRate).toBe(1);
    expect(outcome.observation?.candidate.passRate).toBe(1);

    const promoted = await getCanaryRollout(sql, started.rollout.id);
    expect(promoted?.status).toBe('promoted');
    expect(promoted?.endedAt).toBeTruthy();
    expect((await getProposal(sql, proposal.id))?.status).toBe('merged');

    const events = await listCanaryEvents(sql, { rolloutId: started.rollout.id });
    expect(events.map((event) => event.type)).toEqual(['canary.started', 'canary.promoted']);
    expect(events[1]?.payload).toMatchObject({
      actor: 'canary-observer',
      candidateVersion: active.candidateVersion,
      stableVersion: active.stableVersion,
      mergedCommit: outcome.promotedCommit,
    });
    expect((events[1]?.payload.evidence as Record<string, unknown>)?.threshold).toBe(0.1);
  }, 180_000);

  test('rolls back automatically when the candidate pass rate regresses', async () => {
    const proposal = await createComposedProposal('regress');
    const started = await startCanaryRollout({
      factory: FACTORY,
      factoryRoot,
      definitionRepo: `factory/${FACTORY}`,
      baseBranch: 'main',
      proposal,
      stableCommit: STABLE_COMMIT,
      canaryPercent: 100,
      rollbackThreshold: 0.1,
      observationWindowHours: 1,
      observationWindowMs: 30_000,
      checkIntervalMs: 200,
      actor: 'itest',
      reason: 'regression fixture',
    });

    const active = await waitForActive(started.rollout.id);
    expect(active.status).toBe('active');

    for (const label of ['stable-a', 'stable-b', 'stable-c']) {
      await seedScoredRun({ label, definitionCommit: STABLE_COMMIT, passing: true, score: 1 });
    }
    for (const label of ['candidate-a', 'candidate-b', 'candidate-c']) {
      await seedScoredRun({
        label,
        definitionCommit: active.candidateCommit as string,
        passing: false,
        score: 0,
      });
    }

    const outcome = await outcomeOf(canaryWorkflowId(started.rollout.id));
    expect(outcome.status).toBe('rolled_back');
    expect(outcome.reason).toBe('pass_rate_regression');
    expect(outcome.observation?.regressionExceeded).toBe(true);
    expect(outcome.observation?.stable.passRate).toBe(1);
    expect(outcome.observation?.candidate.passRate).toBe(0);

    const rolled = await getCanaryRollout(sql, started.rollout.id);
    expect(rolled?.status).toBe('rolled_back');
    expect(rolled?.reason).toContain('pass_rate_regression');
    expect((await getProposal(sql, proposal.id))?.status).toBe('rolled_back');

    const events = await listCanaryEvents(sql, { rolloutId: started.rollout.id });
    const rollback = events.find((event) => event.type === 'canary.rolled_back');
    expect(rollback).toBeDefined();
    expect(rollback?.payload).toMatchObject({
      automatic: true,
      actor: 'canary-observer',
      canaryPercent: 100,
      rollbackThreshold: 0.1,
    });
    expect((rollback?.payload.evidence as Record<string, unknown>)?.passRateDelta).toBe(-1);
  }, 180_000);

  test('manual rollback returns routing to stable regardless of the window', async () => {
    const proposal = await createComposedProposal('manual');
    const started = await startCanaryRollout({
      factory: FACTORY,
      factoryRoot,
      definitionRepo: `factory/${FACTORY}`,
      baseBranch: 'main',
      proposal,
      stableCommit: STABLE_COMMIT,
      canaryPercent: 25,
      rollbackThreshold: 0.1,
      observationWindowHours: 6,
      checkIntervalMs: 60_000,
      actor: 'itest',
      reason: 'manual fixture',
    });

    const active = await waitForActive(started.rollout.id);
    expect(active.status).toBe('active');

    const rolled = await rollbackCanaryRollout({
      rolloutId: active.id,
      factory: FACTORY,
      actor: 'grace',
      reason: 'incident 42: rolling back now',
    });
    expect(rolled.changed).toBe(true);
    expect(rolled.rollout.status).toBe('rolled_back');
    expect(rolled.rollout.reason).toBe('incident 42: rolling back now');

    await signalCanaryRollback(active.id, {
      actor: 'grace',
      reason: 'incident 42: rolling back now',
    });

    const outcome = await outcomeOf(canaryWorkflowId(active.id));
    expect(outcome.status).toBe('rolled_back');
    expect(outcome.reason).toBe('incident 42: rolling back now');
    expect(outcome.actor).toBe('grace');

    const events = await listCanaryEvents(sql, { rolloutId: active.id });
    expect(events.map((event) => event.type)).toEqual(['canary.started', 'canary.rolled_back']);
    expect(events[1]?.payload).toMatchObject({
      automatic: false,
      actor: 'grace',
      reason: 'incident 42: rolling back now',
    });

    // Idempotent: a second rollback is a no-op, never a second event.
    const again = await rollbackCanaryRollout({
      rolloutId: active.id,
      factory: FACTORY,
      actor: 'grace',
      reason: 'duplicate',
    });
    expect(again.changed).toBe(false);
    expect((await listCanaryEvents(sql, { rolloutId: active.id })).length).toBe(2);
  }, 180_000);

  test('refuses to start a second rollout while one is active', async () => {
    const first = await createComposedProposal('exclusive-a');
    const second = await createComposedProposal('exclusive-b');
    const started = await startCanaryRollout({
      factory: FACTORY,
      factoryRoot,
      definitionRepo: `factory/${FACTORY}`,
      baseBranch: 'main',
      proposal: first,
      stableCommit: STABLE_COMMIT,
      canaryPercent: 10,
      rollbackThreshold: 0.1,
      observationWindowHours: 1,
      observationWindowMs: 60_000,
      checkIntervalMs: 60_000,
      actor: 'itest',
      reason: 'exclusivity fixture',
    });
    await waitForActive(started.rollout.id);

    await expect(
      startCanaryRollout({
        factory: FACTORY,
        factoryRoot,
        definitionRepo: `factory/${FACTORY}`,
        baseBranch: 'main',
        proposal: second,
        stableCommit: STABLE_COMMIT,
        canaryPercent: 10,
        rollbackThreshold: 0.1,
        observationWindowHours: 1,
        actor: 'itest',
        reason: 'must be refused',
      }),
    ).rejects.toMatchObject({ code: 'canary_active' });

    await rollbackCanaryRollout({
      rolloutId: started.rollout.id,
      factory: FACTORY,
      actor: 'itest',
      reason: 'cleanup',
    });
    await signalCanaryRollback(started.rollout.id, { actor: 'itest', reason: 'cleanup' });
    await outcomeOf(canaryWorkflowId(started.rollout.id));
  }, 180_000);
});
