import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { req } from './helpers';
import { SQL } from 'bun';
import { existsSync, rmSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Hono } from 'hono';
import {
  assignCanaryVersion,
  createProposal,
  getCanaryRollout,
  getProposal,
  loadOrThrow,
  recordProbe,
  recordProposalEdit,
  serializeDefinition,
} from '@factory/core';
import {
  canaryCandidateRoot,
  closeClient,
  getSql,
  publishCanaryCandidate,
  setForge,
  type CanaryWorkflowInput,
} from '@factory/orchestration';
import { FakeForge } from '@factory/forge';
import { composeCandidate } from '@factory/evals';
import { createApp } from '../src/app';
import { loadApiConfig, type ApiConfig } from '../src/config';

/**
 * Canary API integration (Phase 5b, ADR-021).
 *
 * Opt-in like the other API integration tests:
 *
 *   docker compose up -d
 *   DATABASE_URL=postgres://factory:factory@localhost:5433/factory \
 *   TEMPORAL_ADDRESS=localhost:7233 RUN_INTEGRATION=1 \
 *   bun test apps/api/test/canary.integration.test.ts
 *
 * The API starts workflows on a dedicated task queue with no worker. Publishing the
 * candidate is the same shared function the workflow activity calls, so the routing and
 * promotion paths are exercised end to end without racing the compose worker.
 */

const enabled =
  process.env.RUN_INTEGRATION === '1' &&
  Boolean(process.env.DATABASE_URL) &&
  Boolean(process.env.TEMPORAL_ADDRESS);

const suite = enabled ? describe : describe.skip;

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');
const MIGRATIONS = join(REPO_ROOT, 'packages', 'core', 'migrations');
const FACTORY = 'example-lights-off';

let config: ApiConfig;
let app: Hono;
let sql: SQL;

const createdWorkItems: string[] = [];
const createdProposals: string[] = [];
const createdRollouts: string[] = [];

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

const JSON_HEADERS = { 'content-type': 'application/json' };

async function postJson(path: string, body: unknown): Promise<Response> {
  return await req(app, path, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
}

async function getJson<T>(path: string): Promise<T> {
  const response = await req(app, path);
  expect(response.status).toBe(200);
  return (await response.json()) as T;
}

function uniqueId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

async function composedProposal(label: string): Promise<{ proposalId: string; diff: unknown }> {
  const definition = loadOrThrow(join(REPO_ROOT, 'factories', FACTORY));
  const before = serializeDefinition(definition).find(
    (file) => file.path === 'agents/implement/agent.md',
  );
  expect(before).toBeDefined();
  const composed = composeCandidate(definition, [
    {
      kind: 'invariant',
      path: 'agents/implement/agent.md',
      rationale: `canary API fixture ${label}`,
      content: `${before!.content}\n\nAlways re-read the work item scope. (${label})\n`,
    },
  ]);
  const proposalId = uniqueId('prop_canary_api');
  await createProposal(sql, {
    id: proposalId,
    factory: FACTORY,
    authority: 'canary',
    status: 'accepted',
    title: `Canary API fixture ${label}`,
    summary: `canary API integration fixture ${label}`,
    impact: 1,
    evidence: { runIds: [`run_fixture_${label}`], failedRuns: 1, totalRuns: 2, costUsd: 0.1 },
    failureSignature: `canary_api:${label}`,
    files: composed.changedPaths,
    diff: composed.diff,
    candidateHash: composed.candidateHash,
    clusterKey: `canary-api:${label}`,
  });
  createdProposals.push(proposalId);
  return { proposalId, diff: composed.diff };
}

async function publishFor(rolloutId: string): Promise<void> {
  const rollout = await getCanaryRollout(sql, rolloutId);
  expect(rollout).toBeDefined();
  const input: CanaryWorkflowInput = {
    rolloutId,
    factory: FACTORY,
    factoryRoot: join(REPO_ROOT, 'factories', FACTORY),
    proposalId: rollout!.proposalId,
    definitionRepo: `factory/${FACTORY}`,
    baseBranch: 'main',
    stableVersion: rollout!.stableVersion,
    stableCommit: rollout!.stableCommit as string,
    candidateVersion: rollout!.candidateVersion,
    canaryPercent: rollout!.canaryPercent,
    rollbackThreshold: rollout!.rollbackThreshold,
    observationWindowHours: rollout!.observationWindowHours,
    actor: 'itest',
    reason: 'itest publish',
  };
  const published = await publishCanaryCandidate(input);
  expect(published.rollout.status).toBe('active');
  createdRollouts.push(rolloutId);
}

async function createWorkItem(title: string): Promise<{
  id: string;
  definitionVersion: 'stable' | 'candidate';
  definitionCommit: string;
  canaryRolloutId: string | null;
}> {
  const response = await postJson('/work-items', {
    factory: FACTORY,
    title,
    harness: 'fake',
  });
  expect(response.status).toBe(201);
  const body = (await response.json()) as {
    workItem: {
      id: string;
      definitionVersion: 'stable' | 'candidate';
      definitionCommit: string;
      canaryRolloutId: string | null;
    };
  };
  createdWorkItems.push(body.workItem.id);
  return body.workItem;
}

suite('canary API', () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.DATABASE_URL as string;
    process.env.TEMPORAL_ADDRESS = process.env.TEMPORAL_ADDRESS as string;
    process.env.TEMPORAL_TASK_QUEUE = `factory-canary-api-itest-${process.pid}-${Date.now()}`;
    process.env.FACTORY_ROOT = join(REPO_ROOT, 'factories');
    process.env.REPO_ROOT = REPO_ROOT;

    await migrate(process.env.DATABASE_URL as string);
    config = loadApiConfig();
    app = createApp(config);
    sql = getSql(config.databaseUrl);
    setForge('fake', new FakeForge());
  }, 60_000);

  afterAll(async () => {
    for (const workItemId of createdWorkItems) {
      await sql`delete from work_items where id = ${workItemId}`.catch(() => undefined);
    }
    for (const proposalId of createdProposals) {
      await sql`delete from proposals where id = ${proposalId}`.catch(() => undefined);
    }
    for (const rolloutId of createdRollouts) {
      const root = canaryCandidateRoot(rolloutId);
      if (existsSync(root)) rmSync(join(root, '..'), { recursive: true, force: true });
    }
    setForge('fake', null);
    await closeClient();
  }, 60_000);

  test('start → deterministic routing → promote → stable again', async () => {
    const { proposalId } = await composedProposal('promote');
    const start = await postJson(`/factories/${FACTORY}/canary`, {
      proposalId,
      actor: 'ada',
      reason: 'itest: promote',
      canaryPercent: 50,
    });
    expect(start.status).toBe(202);
    const started = (await start.json()) as {
      rollout: { id: string; status: string; canaryPercent: number; candidateVersion: string };
      workflow: { workflowId: string } | null;
    };
    expect(started.rollout.status).toBe('pending');
    expect(started.rollout.canaryPercent).toBe(50);
    expect(started.rollout.candidateVersion).toMatch(/^factory-v\d+-candidate$/);
    expect(started.workflow?.workflowId).toBe(`canary-${started.rollout.id}`);

    await publishFor(started.rollout.id);
    const rollout = await getCanaryRollout(sql, started.rollout.id);
    expect(rollout?.status).toBe('active');
    expect(rollout?.candidateCommit).toMatch(/^[0-9a-f]{40}$/);

    const view = await getJson<{
      active: {
        rollout: { id: string; status: string; candidateCommit: string };
        split: { canaryPercent: number; stablePercent: number };
        window: { remainingMs: number };
        events: { type: string }[];
      } | null;
    }>(`/factories/${FACTORY}/canary`);
    expect(view.active?.rollout.status).toBe('active');
    expect(view.active?.split).toMatchObject({ canaryPercent: 50, stablePercent: 50 });
    expect(view.active?.window.remainingMs).toBeGreaterThan(0);
    expect(view.active?.events.map((event) => event.type)).toEqual(['canary.started']);

    // Route work items deterministically: every assignment must equal the hash, and a
    // candidate item must pin the candidate commit + rollout. Keep creating items until
    // both sides are observed (at 50% that is at most a few items; capped for safety).
    const items = [];
    let candidates = 0;
    for (
      let index = 0;
      index < 16 && (candidates === 0 || candidates === items.length);
      index += 1
    ) {
      const item = await createWorkItem(`canary routing ${index}`);
      items.push(item);
      if (item.definitionVersion === 'candidate') candidates += 1;
    }
    for (const item of items) {
      const expected = assignCanaryVersion(item.id, 50);
      expect(item.definitionVersion).toBe(expected);
      if (expected === 'candidate') {
        expect(item.canaryRolloutId).toBe(started.rollout.id);
        expect(item.definitionCommit).toBe(rollout?.candidateCommit as string);
      } else {
        expect(item.canaryRolloutId).toBeNull();
        expect(item.definitionCommit).toBe(rollout?.stableCommit as string);
      }
    }
    expect(candidates).toBeGreaterThan(0);
    expect(candidates).toBeLessThan(items.length);

    const promote = await postJson('/canary/promote', {
      factory: FACTORY,
      rolloutId: started.rollout.id,
      actor: 'ada',
      reason: 'itest: no regression',
    });
    expect(promote.status).toBe(200);
    const promoted = (await promote.json()) as {
      rollout: { status: string; reason: string };
      mergedCommit: string | null;
      delivery: boolean;
    };
    expect(promoted.rollout.status).toBe('promoted');
    expect(promoted.mergedCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(promoted.delivery).toBe(true);

    const after = await getJson<{
      active: unknown;
      history: { rollout: { id: string; status: string }; events: { type: string }[] }[];
    }>(`/factories/${FACTORY}/canary`);
    expect(after.active).toBeNull();
    const promotedView = after.history.find((entry) => entry.rollout.id === started.rollout.id);
    expect(promotedView?.rollout.status).toBe('promoted');
    expect(promotedView?.events.map((event) => event.type)).toEqual([
      'canary.started',
      'canary.promoted',
    ]);
    expect((await getProposal(sql, proposalId))?.status).toBe('merged');

    const stableItem = await createWorkItem('after promotion');
    expect(stableItem.definitionVersion).toBe('stable');
    expect(stableItem.canaryRolloutId).toBeNull();

    const refused = await postJson('/canary/rollback', {
      factory: FACTORY,
      actor: 'ada',
      reason: 'nothing to roll back',
    });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { code: string }).code).toBe('no_active_canary');
  }, 120_000);

  test('manual rollback returns routing to stable immediately', async () => {
    const { proposalId } = await composedProposal('rollback');
    const start = await postJson(`/factories/${FACTORY}/canary`, {
      proposalId,
      actor: 'ada',
      reason: 'itest: rollback',
      canaryPercent: 100,
    });
    expect(start.status).toBe(202);
    const started = (await start.json()) as { rollout: { id: string } };
    await publishFor(started.rollout.id);

    const rolled = await postJson('/canary/rollback', {
      factory: FACTORY,
      rolloutId: started.rollout.id,
      actor: 'grace',
      reason: 'incident 42',
    });
    expect(rolled.status).toBe(200);
    const body = (await rolled.json()) as {
      rollout: { status: string; reason: string };
      delivery: boolean;
      metrics: { candidate: { passRate: number | null } } | null;
    };
    expect(body.rollout.status).toBe('rolled_back');
    expect(body.rollout.reason).toBe('incident 42');
    expect(body.delivery).toBe(true);
    expect(body.metrics).not.toBeNull();

    const view = await getJson<{
      active: unknown;
      history: { rollout: { id: string; status: string; reason: string }; events: { type: string }[] }[];
    }>(`/factories/${FACTORY}/canary`);
    expect(view.active).toBeNull();
    const entry = view.history.find((row) => row.rollout.id === started.rollout.id);
    expect(entry?.rollout.status).toBe('rolled_back');
    expect(entry?.rollout.reason).toBe('incident 42');
    expect(entry?.events.map((event) => event.type)).toEqual([
      'canary.started',
      'canary.rolled_back',
    ]);

    const item = await createWorkItem('after rollback');
    expect(item.definitionVersion).toBe('stable');
    expect(item.canaryRolloutId).toBeNull();
    expect((await getProposal(sql, proposalId))?.status).toBe('rolled_back');
  }, 120_000);

  test('apply starts a real rollout instead of refusing with canary_not_available', async () => {
    const { proposalId, diff } = await composedProposal('apply');
    const editId = uniqueId('edit_canary_api');
    await recordProposalEdit(sql, {
      id: editId,
      proposalId,
      kind: 'invariant',
      path: 'agents/implement/agent.md',
      rationale: 'canary API apply fixture',
      content: ((diff as { path: string; before: string; after: string }[])[0]?.after ?? ''),
      scope: 'in_scope',
    });
    await recordProbe(sql, {
      id: uniqueId('probe_canary_api'),
      proposalId,
      editId,
      workItemId: null,
      runId: null,
      matchedInputs: { uncalibrated: false },
      baselineScore: 0,
      candidateScore: 1,
      delta: 1,
      winner: true,
    });

    const applied = await postJson(`/proposals/${proposalId}/apply`, {
      actor: 'ada',
      reason: 'itest: apply canary',
    });
    expect(applied.status).toBe(200);
    const body = (await applied.json()) as {
      decision: { action: string; code: string };
      rollout?: { id: string; status: string; canaryPercent: number };
      proposal: { status: string };
    };
    expect(body.decision.action).toBe('canary');
    expect(body.decision.code).toBe('canary_rollout');
    expect(body.rollout?.status).toBe('pending');
    expect(body.rollout?.canaryPercent).toBe(10);
    expect(body.proposal.status).toBe('canary');
    createdRollouts.push(body.rollout?.id as string);

    const cancelled = await postJson('/canary/rollback', {
      factory: FACTORY,
      proposalId,
      actor: 'ada',
      reason: 'itest: cancel before publishing',
    });
    expect(cancelled.status).toBe(200);
    expect(((await cancelled.json()) as { rollout: { status: string } }).rollout.status).toBe(
      'rolled_back',
    );
    expect((await getProposal(sql, proposalId))?.status).toBe('rolled_back');
  }, 120_000);
});
