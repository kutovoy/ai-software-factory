import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { SQL } from 'bun';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Worker } from '@temporalio/worker';
import {
  createCalibrationSet,
  getImprovementRun,
  listImprovementEvents,
  listLessons,
  listProposalEdits,
  listProposals,
  loadOrThrow,
  recordCalibrationResult,
  recordScore,
  type ProposalRecord,
} from '@factory/core';
import { loadScorerRegistry } from '@factory/evals';
import { FakeForge } from '@factory/forge';
import { closeClient, getClient } from '../src/client';
import { closeSql, insertRun, setSql } from '../src/db';
import { loadConfig, type OrchestrationConfig } from '../src/config';
import { setForge } from '../src/activities/forge';
import { setImprovementProbeRunner } from '../src/activities/improvement';
import { clearSessions } from '../src/sessions';
import { createWorker } from '../src/worker';
import { startImprovementWorkflow } from '../src/improvement-client';
import type {
  ImprovementWorkflowInput,
  ImprovementWorkflowOutcome,
} from '../src/types';

/**
 * Improvement integration (Phase 5).
 *
 * Needs Temporal + Postgres:
 *
 *   docker compose up -d
 *   DATABASE_URL=postgres://factory:factory@localhost:5433/factory \
 *   TEMPORAL_ADDRESS=localhost:7233 RUN_INTEGRATION=1 \
 *   bun test packages/orchestration/test/improvement.integration.test.ts
 *
 * A scored corpus (one cancelled run + one passing run) → proposal → probe → candidate →
 * PR on the fake forge. No model, no network, no credentials.
 */

const enabled =
  process.env.RUN_INTEGRATION === '1' &&
  Boolean(process.env.DATABASE_URL) &&
  Boolean(process.env.TEMPORAL_ADDRESS);

const suite = enabled ? describe : describe.skip;

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');
const EXAMPLE = join(REPO_ROOT, 'factories', 'example');
const FACTORY = 'improve-fixture';
const MIGRATIONS = join(REPO_ROOT, 'packages', 'core', 'migrations');

const CANCELLED_RUN = 'run_01J0000000000000000000000_implement_1';
const PASSING_RUN = 'run_01J0000000000000000000001_implement_1';

let config: OrchestrationConfig;
let worker: Worker;
let running: Promise<void>;
let factoryRoot: string;
let sql: SQL;
let forge: FakeForge;
let rubricHash: string;
let judgeModel: string;

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

async function seedCorpus(): Promise<void> {
  for (const [runId, status, cost] of [
    [CANCELLED_RUN, 'cancelled', 0.4],
    [PASSING_RUN, 'ok', 0.2],
  ] as const) {
    await insertRun({
      runId,
      factory: FACTORY,
      definitionCommit: 'a'.repeat(40),
      definitionDirty: false,
      harness: 'fake',
      model: 'fake/fake-model',
      runner: 'fake',
      kind: 'run',
      title: `improvement fixture ${status}`,
      input: {
        runId,
        factory: FACTORY,
        factoryRoot,
        definitionCommit: 'a'.repeat(40),
        definitionDirty: false,
        harness: 'fake',
        runner: 'fake',
        prompt: { text: `fixture work for ${status}` },
        kind: 'run',
        proxyModels: [],
      },
      workflowId: `fixture-${runId}`,
    });
    await sql`
      update runs set status = ${status}, ended_at = now(), cost_usd = ${cost}
      where id = ${runId}
    `;
  }

  await recordScore(sql, {
    id: `sc_${CANCELLED_RUN}_scope`,
    factory: FACTORY,
    runId: CANCELLED_RUN,
    workItemId: 'wi_01J0000000000000000000000',
    stage: 'implement',
    scorer: 'scope',
    scorerClass: 'judge',
    rubricHash,
    status: 'ok',
    label: 'non_compliant',
    score: 0,
    passing: false,
    rationale: 'the run was cancelled before delivering the work item',
    evidenceRefs: [`run:${CANCELLED_RUN}`],
    uncalibrated: false,
    provenance: { judgeModel, judgeModelVersion: 'stub-v1', costUsd: 0 },
  });

  await recordScore(sql, {
    id: `sc_${PASSING_RUN}_scope`,
    factory: FACTORY,
    runId: PASSING_RUN,
    workItemId: 'wi_01J0000000000000000000001',
    stage: 'implement',
    scorer: 'scope',
    scorerClass: 'judge',
    rubricHash,
    status: 'ok',
    label: 'compliant',
    score: 1,
    passing: true,
    rationale: 'scoped to the work item',
    evidenceRefs: [`run:${PASSING_RUN}`],
    uncalibrated: false,
    provenance: { judgeModel, judgeModelVersion: 'stub-v1', costUsd: 0 },
  });
}

function inputFor(overrides: Partial<ImprovementWorkflowInput> = {}): ImprovementWorkflowInput {
  return {
    improvementRunId: `imp_itest_${Date.now()}_${Math.floor(Math.random() * 1e6)}`,
    factory: FACTORY,
    factoryRoot,
    definitionCommit: 'a'.repeat(40),
    definitionDirty: false,
    trigger: 'on_demand',
    authority: 'propose_only',
    canaryPercent: null,
    rollbackThreshold: null,
    observationWindowHours: 24,
    maxProbes: 3,
    minScoredRuns: 1,
    windowDays: 30,
    maxProposals: 5,
    definitionRepo: `factory/${FACTORY}`,
    baseBranch: 'main',
    ...overrides,
  };
}

async function runImprovement(
  input: ImprovementWorkflowInput,
): Promise<ImprovementWorkflowOutcome> {
  const started = await startImprovementWorkflow(input, config);
  const client = await getClient(config);
  return (await client.workflow.getHandle(started.workflowId).result()) as ImprovementWorkflowOutcome;
}

suite('improvement workflow on the fake forge', () => {
  beforeAll(async () => {
    factoryRoot = mkdtempSync(join(tmpdir(), 'factory-improve-def-'));
    cpSync(EXAMPLE, factoryRoot, { recursive: true });
    const manifestPath = join(factoryRoot, 'factory.yaml');
    writeFileSync(
      manifestPath,
      readFileSync(manifestPath, 'utf8').replace(/^name: example$/m, `name: ${FACTORY}`),
    );

    process.env.FACTORY_ROOT = join(factoryRoot, '..');
    process.env.RUNS_DIR = mkdtempSync(join(tmpdir(), 'factory-improve-runs-'));
    process.env.TEMPORAL_TASK_QUEUE = `factory-improve-itest-${process.pid}-${Date.now()}`;

    await migrate(process.env.DATABASE_URL as string);
    setSql(new SQL(process.env.DATABASE_URL as string, { max: 4 }));
    sql = new SQL(process.env.DATABASE_URL as string, { max: 4 });

    const scorer = loadScorerRegistry(loadOrThrow(factoryRoot)).find(
      (entry) => entry.name === 'scope',
    );
    expect(scorer).toBeDefined();
    rubricHash = scorer!.rubricHash;
    judgeModel = scorer!.judgeModel;

    const setId = `cal_improve_${Date.now()}`;
    await createCalibrationSet(sql, {
      id: setId,
      factory: FACTORY,
      scorer: 'scope',
      name: 'improvement integration golden set',
      minSize: 1,
      threshold: 1,
      tolerance: 0,
    });
    await recordCalibrationResult(sql, {
      setId,
      factory: FACTORY,
      scorer: 'scope',
      rubricHash,
      judgeModel,
      judgeModelVersion: 'stub-v1',
      sampleSize: 1,
      agreementExact: 1,
      agreementWithinTolerance: 1,
      tolerance: 0,
      threshold: 1,
      confusion: { compliant: { compliant: 1 } },
      verdict: 'pass',
    });

    await seedCorpus();

    config = {
      ...loadConfig(),
      taskQueue: process.env.TEMPORAL_TASK_QUEUE as string,
      runsDir: process.env.RUNS_DIR as string,
      maxConcurrentActivityTaskExecutions: 8,
      maxConcurrentWorkflowTaskExecutions: 8,
    };

    forge = new FakeForge();
    setForge('fake', forge);
    setImprovementProbeRunner(null);
    clearSessions();
    worker = await createWorker(config);
    running = worker.run();
  }, 120_000);

  afterAll(async () => {
    worker?.shutdown();
    await running?.catch(() => undefined);
    setImprovementProbeRunner(null);
    clearSessions();
    setForge('fake', null);
    await closeSql();
    await closeClient();
    await sql?.close();
    rmSync(factoryRoot, { recursive: true, force: true });
    rmSync(process.env.RUNS_DIR as string, { recursive: true, force: true });
  }, 90_000);

  test('scored corpus → proposal → probe → candidate → PR (propose_only)', async () => {
    const input = inputFor();
    const outcome = await runImprovement(input);

    expect(outcome.status).toBe('completed');
    expect(outcome.decision).toBe('pr_opened');
    // The cancelled run carries two failure signals: the run status and the non-compliant
    // score, so the observer produces two deduped proposals.
    expect(outcome.proposals.length).toBeGreaterThanOrEqual(1);
    expect(outcome.proposals.every((entry) => entry.status === 'pr_open')).toBe(true);

    const proposalOutcome = outcome.proposals.find(
      (entry) => entry.failureSignature === 'scope:non_compliant',
    )!;
    expect(proposalOutcome.status).toBe('pr_open');
    expect(proposalOutcome.candidateHash).toMatch(/^[0-9a-f]{64}$/);
    expect(proposalOutcome.prUrl).toContain('pull');
    expect(proposalOutcome.probes.length).toBeGreaterThan(0);
    expect(proposalOutcome.probes.every((probe) => probe.winner)).toBe(true);

    const proposals = await listProposals(sql, { factory: FACTORY, improvementRunId: input.improvementRunId });
    expect(proposals.length).toBeGreaterThanOrEqual(1);
    const proposal = proposals.find(
      (entry) => entry.failureSignature === 'scope:non_compliant',
    )! as ProposalRecord;
    expect(proposal.failureSignature).toBe('scope:non_compliant');
    expect(proposal.impact).toBeGreaterThan(0);
    expect(proposal.files).toContain('agents/implement/agent.md');
    expect(proposal.files).toContain('scorers/scope/scorer.md');
    expect(proposal.diff.length).toBeGreaterThan(0);

    const edits = await listProposalEdits(sql, proposal.id);
    expect(edits.map((edit) => edit.kind).sort()).toEqual(['domain', 'invariant']);
    expect(edits.every((edit) => edit.scope === 'in_scope' && !edit.rejected)).toBe(true);

    const events = await listImprovementEvents(sql, input.improvementRunId);
    const types = events.map((event) => event.type);
    expect(types).toContain('improvement.started');
    expect(types).toContain('proposal.created');
    expect(types).toContain('probe.completed');
    expect(types).toContain('candidate.published');

    const lessons = await listLessons(sql, { factory: FACTORY, includeShared: false });
    expect(lessons.length).toBeGreaterThanOrEqual(1);
    expect(lessons.some((lesson) => lesson.cue === 'scope:non_compliant')).toBe(true);
    expect(existsSync(join(process.env.RUNS_DIR as string, 'experience', FACTORY, 'INDEX.md'))).toBe(true);
    expect(existsSync(join(process.env.RUNS_DIR as string, 'experience', FACTORY, 'EXPERIENCE.md'))).toBe(true);

    const run = await getImprovementRun(sql, input.improvementRunId);
    expect(run?.status).toBe('completed');
    expect(run?.decision).toBe('pr_opened');
    expect(run?.proposals).toBeGreaterThanOrEqual(1);
    expect(run?.lessons).toBeGreaterThanOrEqual(1);
    expect(run?.eligibility).toMatchObject({ eligible: true, scoredRuns: 2 });
  }, 120_000);

  test('auto_merge refuses without a benchmark attestation and opens a PR', async () => {
    const input = inputFor({ authority: 'auto_merge_on_benchmark' });
    const outcome = await runImprovement(input);

    expect(outcome.status).toBe('completed');
    expect(outcome.decision).toBe('pr_opened');
    const proposal = outcome.proposals[0]!;
    expect(proposal.status).toBe('pr_open');
    expect(proposal.prNumber).toBeTruthy();

    const run = await getImprovementRun(sql, input.improvementRunId);
    expect(run?.decision).toBe('pr_opened');
  }, 120_000);

  test('canary returns canary_not_available and records the candidate', async () => {
    const input = inputFor({
      authority: 'canary',
      canaryPercent: 10,
      rollbackThreshold: 0.1,
    });
    const outcome = await runImprovement(input);

    expect(outcome.status).toBe('completed');
    expect(outcome.decision).toBe('canary_not_available');
    const proposal = outcome.proposals[0]!;
    expect(proposal.status).toBe('canary_not_available');
    expect(proposal.candidateHash).toMatch(/^[0-9a-f]{64}$/);
    expect(proposal.prUrl).toBeNull();
  }, 120_000);

  test('an ineligible corpus completes as skipped without a proposal', async () => {
    const input = inputFor({ minScoredRuns: 99 });
    const outcome = await runImprovement(input);

    expect(outcome.status).toBe('skipped');
    expect(outcome.decision).toBe('ineligible');
    expect(outcome.proposals).toEqual([]);

    const run = await getImprovementRun(sql, input.improvementRunId);
    expect(run?.status).toBe('skipped');
    expect(run?.eligibility).toMatchObject({ eligible: false });
  }, 120_000);
});
