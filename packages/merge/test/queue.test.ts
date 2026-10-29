import { describe, expect, test } from 'bun:test';
import {
  FakeForge,
  repoKey,
  type CheckRun,
  type ChecksResult,
  type CodeForge,
  type RepoRef,
} from '@factory/forge';
import {
  runMergeBatch,
  revertMergeBatch,
  selectBatch,
  type MergeQueueBatch,
  type MergeQueueEvent,
  type MergeQueueItem,
} from '../src/queue';

const REPO: RepoRef = { owner: 'acme', name: 'api-service' };

/**
 * Merge queue engine tests against the fake forge (spec `merge-queue`).
 *
 * `checkStack` models a semantic conflict: every PR is green on its own, but the merged
 * stack is red while a specific branch's file is present on the default branch. That is the
 * failure mode the queue exists for, and it makes bisect/revert deterministic.
 */

async function seedPrs(forge: FakeForge, branches: string[]): Promise<MergeQueueItem[]> {
  const items: MergeQueueItem[] = [];
  for (const [index, branch] of branches.entries()) {
    await forge.createBranch({ repo: REPO, name: branch });
    await forge.commit({
      repo: REPO,
      branch,
      message: `change for ${branch}`,
      files: [{ path: `changes/${branch}.txt`, content: `${branch}\n` }],
    });
    const pull = await forge.openPullRequest({ repo: REPO, head: branch, title: `PR ${branch}` });
    items.push({
      id: `mb_item_${index + 1}`,
      pullRequestNumber: pull.number,
      head: branch,
      status: 'batched',
    });
  }
  return items;
}

function batchOf(items: MergeQueueItem[]): MergeQueueBatch {
  return {
    id: 'mb_batch_1',
    factory: 'example',
    repo: REPO,
    items,
    baseSha: '',
    mergeSha: null,
    status: 'queued',
    checks: [],
    evidence: {},
  };
}

/** Stack is red while any of `offenders` has landed on the default branch. */
function stackGateOffenders(offenders: string[]) {
  return async (input: {
    forge: CodeForge;
    repo: RepoRef;
    ref: string;
  }): Promise<ChecksResult> => {
    const forge = input.forge as FakeForge;
    // Gate the *given* merged-stack head (a bisect prefix), not the current branch head.
    const head = await forge.checkout({ repo: input.repo, ref: input.ref });
    const present = offenders.filter((branch) => `changes/${branch}.txt` in head.files);
    const checks: CheckRun[] =
      present.length > 0
        ? [{ name: 'ci', conclusion: 'failure' }, { name: 'lint', conclusion: 'success' }]
        : [{ name: 'ci', conclusion: 'success' }, { name: 'lint', conclusion: 'success' }];
    return {
      repo: input.repo,
      ref: input.ref,
      checks,
      green: checks.every((check) => check.conclusion === 'success'),
    };
  };
}

describe('merge queue — batching', () => {
  test('the default batch size is 2 and is configurable', () => {
    const queue = [1, 2, 3, 4];
    expect(selectBatch(queue)).toEqual([1, 2]);
    expect(selectBatch(queue, 3)).toEqual([1, 2, 3]);
    expect(selectBatch(queue, 0)).toEqual([1]);
  });
});

describe('merge queue — green batch', () => {
  test('merges every PR as one unit and marks the batch merged', async () => {
    const forge = new FakeForge();
    forge.seedRepo(REPO, { 'README.md': '# api-service\n' });
    const items = await seedPrs(forge, ['factory/wi_1', 'factory/wi_2']);
    const events: MergeQueueEvent[] = [];
    const before = await forge.checkout({ repo: REPO });

    const result = await runMergeBatch(batchOf(items), {
      forge,
      repo: REPO,
      hooks: { onEvent: (event) => { events.push(event); } },
    });

    expect(result.batch.status).toBe('merged');
    expect(result.merged).toHaveLength(2);
    expect(result.needsHuman).toHaveLength(0);
    expect(result.reverted).toBe(false);
    expect(result.batch.baseSha).toBe(before.commit);
    expect(result.batch.mergeSha).toMatch(/^[0-9a-f]{40}$/);

    const after = await forge.checkout({ repo: REPO });
    expect(after.commit).toBe(result.batch.mergeSha as string);
    expect(after.files['changes/factory/wi_1.txt']).toBe('factory/wi_1\n');
    expect(after.files['changes/factory/wi_2.txt']).toBe('factory/wi_2\n');

    const types = events.map((event) => event.type);
    expect(types).toContain('merge.batch.started');
    expect(types).toContain('merge.batch.merged');
    expect(forge.listPullRequests(REPO).every((pull) => pull.state === 'merged')).toBe(true);
  });
});

describe('merge queue — bisect on red', () => {
  test('reverts the batch, merges the clean subset and marks the offender needs_human', async () => {
    const forge = new FakeForge();
    forge.seedRepo(REPO, { 'README.md': '# api-service\n' });
    const items = await seedPrs(forge, ['factory/wi_1', 'factory/wi_2', 'factory/wi_3']);
    const events: MergeQueueEvent[] = [];

    const result = await runMergeBatch(batchOf(items), {
      forge,
      repo: REPO,
      batchSize: 3,
      checkStack: stackGateOffenders(['factory/wi_2']),
      sleep: async () => undefined,
      hooks: { onEvent: (event) => { events.push(event); } },
    });

    expect(result.batch.status).toBe('bisected');
    expect(result.reverted).toBe(true);
    expect(result.needsHuman.map((item) => item.head)).toEqual(['factory/wi_2']);
    // The train keeps every clean merge, before and after the offender.
    expect(result.merged.map((item) => item.head)).toEqual(['factory/wi_1', 'factory/wi_3']);
    expect(result.batch.evidence).toMatchObject({
      mergedPrs: [items[0]!.pullRequestNumber, items[2]!.pullRequestNumber],
      offenders: [items[1]!.pullRequestNumber],
    });

    const offender = result.needsHuman[0]!;
    expect(offender.status).toBe('needs_human');
    expect(offender.evidence).toMatchObject({ reason: 'red_stack', failing: ['ci'] });

    // The offender is not on the default branch; the clean subset is.
    const head = await forge.checkout({ repo: REPO });
    expect(head.files['changes/factory/wi_1.txt']).toBe('factory/wi_1\n');
    expect(head.files['changes/factory/wi_3.txt']).toBe('factory/wi_3\n');
    expect(head.files['changes/factory/wi_2.txt']).toBeUndefined();

    const types = events.map((event) => event.type);
    expect(types).toContain('merge.batch.red');
    expect(types).toContain('merge.reverted');
    expect(types).toContain('merge.item.needs_human');
    expect(types).toContain('merge.bisected');
  });
});

describe('merge queue — check timeout', () => {
  test('fails with checks_timeout, reverts the batch and merges nothing', async () => {
    const forge = new FakeForge();
    forge.seedRepo(REPO, { 'README.md': '# api-service\n' });
    const items = await seedPrs(forge, ['factory/wi_1', 'factory/wi_2']);
    const events: MergeQueueEvent[] = [];
    const before = await forge.checkout({ repo: REPO });

    const result = await runMergeBatch(batchOf(items), {
      forge,
      repo: REPO,
      checksTimeoutMs: 0,
      pollIntervalMs: 0,
      sleep: async () => undefined,
      checkStack: async (input) => ({
        repo: input.repo,
        ref: input.ref,
        checks: [{ name: 'ci', conclusion: 'pending' }],
        green: false,
      }),
      hooks: { onEvent: (event) => { events.push(event); } },
    });

    expect(result.batch.status).toBe('reverted');
    expect(result.batch.reason).toContain('did not complete');
    expect(result.reverted).toBe(true);
    expect(result.merged).toHaveLength(0);
    expect(result.needsHuman).toHaveLength(0);

    // Nothing merged: the default branch is back at the pre-batch tree.
    const after = await forge.checkout({ repo: REPO });
    expect(after.files['changes/factory/wi_1.txt']).toBeUndefined();
    expect(after.commit).not.toBe(before.commit);

    const types = events.map((event) => event.type);
    expect(types).toContain('merge.checks_timeout');
    expect(types).toContain('merge.reverted');
    const timeoutEvent = events.find((event) => event.type === 'merge.checks_timeout');
    expect(timeoutEvent?.payload).toMatchObject({ timeoutMs: 0 });
  });
});

describe('merge queue — revert', () => {
  test('reverts a merged batch as a single commit and records merge.reverted', async () => {
    const forge = new FakeForge();
    forge.seedRepo(REPO, { 'README.md': '# api-service\n' });
    const items = await seedPrs(forge, ['factory/wi_1', 'factory/wi_2']);
    const batch = batchOf(items);

    const merged = await runMergeBatch(batch, { forge, repo: REPO });
    expect(merged.batch.status).toBe('merged');
    const afterMerge = await forge.checkout({ repo: REPO });
    expect(afterMerge.files['changes/factory/wi_2.txt']).toBe('factory/wi_2\n');

    const events: MergeQueueEvent[] = [];
    const reverted = await revertMergeBatch(
      merged.batch,
      { forge, repo: REPO, hooks: { onEvent: (event) => { events.push(event); } } },
      { actor: 'ada', reason: 'production regression' },
    );

    expect(reverted.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(reverted.batch.status).toBe('reverted');
    expect(reverted.batch.actor).toBe('ada');

    const afterRevert = await forge.checkout({ repo: REPO });
    expect(afterRevert.commit).toBe(reverted.sha);
    expect(afterRevert.files['changes/factory/wi_1.txt']).toBeUndefined();
    expect(afterRevert.files['changes/factory/wi_2.txt']).toBeUndefined();

    const event = events.find((candidate) => candidate.type === 'merge.reverted');
    expect(event?.payload).toMatchObject({
      actor: 'ada',
      reason: 'production regression',
      automatic: false,
    });
  });

  test('a manual revert is audited regardless of checks', async () => {
    const forge = new FakeForge();
    forge.seedRepo(REPO, { 'README.md': '# api-service\n' });
    const items = await seedPrs(forge, ['factory/wi_1']);
    const batch = batchOf(items);
    const merged = await runMergeBatch(batch, { forge, repo: REPO });

    // The stack is green now, but a human still reverts it.
    const result = await revertMergeBatch(
      merged.batch,
      { forge, repo: REPO },
      { actor: 'operator', reason: 'incident 42' },
    );
    expect(result.batch.evidence.revert).toMatchObject({ actor: 'operator', automatic: false });
  });
});

describe('merge queue — pre-merge failures', () => {
  test('a PR whose checks are red never enters the stack and is needs_human', async () => {
    const forge = new FakeForge();
    forge.seedRepo(REPO, { 'README.md': '# api-service\n' });
    const items = await seedPrs(forge, ['factory/wi_1', 'factory/wi_2']);
    forge.simulateChecks(REPO, items[1]!.pullRequestNumber, [{ name: 'ci', conclusion: 'failure' }]);

    const result = await runMergeBatch(batchOf(items), { forge, repo: REPO });
    expect(result.merged.map((item) => item.head)).toEqual(['factory/wi_1']);
    expect(result.needsHuman.map((item) => item.head)).toEqual(['factory/wi_2']);
    expect(result.batch.status).toBe('bisected');
  });

  test('a batch where nothing can merge touches nothing and isolates the offender', async () => {
    const forge = new FakeForge();
    forge.seedRepo(REPO, { 'README.md': '# api-service\n' });
    const items = await seedPrs(forge, ['factory/wi_1']);
    forge.simulateChecks(REPO, items[0]!.pullRequestNumber, [{ name: 'ci', conclusion: 'failure' }]);
    const before = await forge.checkout({ repo: REPO });

    const result = await runMergeBatch(batchOf(items), { forge, repo: REPO });
    expect(result.batch.status).toBe('bisected');
    expect(result.merged).toHaveLength(0);
    expect(result.needsHuman).toHaveLength(1);
    expect(result.batch.evidence.offenders).toEqual([items[0]!.pullRequestNumber]);
    expect((await forge.checkout({ repo: REPO })).commit).toBe(before.commit);
  });

  test('already-merged items are skipped, so a retried batch is idempotent', async () => {
    const forge = new FakeForge();
    forge.seedRepo(REPO, { 'README.md': '# api-service\n' });
    const items = await seedPrs(forge, ['factory/wi_1', 'factory/wi_2']);
    const first = await runMergeBatch(batchOf(items), { forge, repo: REPO });
    expect(first.batch.status).toBe('merged');

    const retry = await runMergeBatch(
      { ...first.batch, status: 'queued', items: first.merged.map((item) => ({ ...item })) },
      { forge, repo: REPO },
    );
    expect(retry.batch.status).toBe('merged');
    expect(retry.merged).toHaveLength(2);
    // No new merge happened: the PRs are already merged.
    expect(forge.listPullRequests(REPO).filter((pull) => pull.state === 'merged')).toHaveLength(2);
  });

  test('the batch is bound to the repo key it was created for', () => {
    expect(repoKey(REPO)).toBe('acme/api-service');
  });
});
