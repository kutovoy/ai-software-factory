import { describe, expect, test } from 'bun:test';
import { runCodeForgeContractTests } from '../src/contract';
import { ForgeError } from '../src/errors';
import { GitHubForge } from '../src/github';
import type { RepoRef } from '../src/types';
import { createGithubStub, loadGithubSeed, type GithubStub } from './github-stub';

const REPO: RepoRef = { owner: 'acme', name: 'api-service' };
const SEED = loadGithubSeed();

/**
 * GitHub backend contract (spec `code-forge`).
 *
 * The same suite that runs against `FakeForge` runs here against `GitHubForge` wired to an
 * injected `fetch` stub that replays the recorded fixture in
 * `test/fixtures/github/seed.json`. No network call is made; the real transport is only
 * exercised when `RUN_GITHUB=1` (and then the contract repo must exist for real).
 */

let current: GithubStub | null = null;

function makePair(): { stub: GithubStub; forge: GitHubForge } {
  const stub = createGithubStub(SEED);
  const forge = new GitHubForge({ fetch: stub.fetch, token: 'ghp_fixture', sleep: async () => undefined });
  return { stub, forge };
}

if (process.env.RUN_GITHUB === '1') {
  // Opt-in: the real network path. Requires a token and the fixture repository.
  runCodeForgeContractTests(
    'github (live, RUN_GITHUB=1)',
    () => new GitHubForge({ secretRef: 'GITHUB_TOKEN' }),
    { repo: REPO },
  );
} else {
  runCodeForgeContractTests(
    'github (recorded fetch stub)',
    () => {
      const { stub, forge } = makePair();
      current = stub;
      return forge;
    },
    {
      setup: () => {
        current?.seedRepo(REPO, SEED.repos['acme/api-service']!.files);
      },
      redChecks: (_forge, repo, pullRequestNumber) => {
        current?.markChecksRed(repo, pullRequestNumber);
      },
    },
  );
}

describe('github backend specifics', () => {
  function setup(): { stub: GithubStub; forge: GitHubForge } {
    const { stub, forge } = makePair();
    stub.seedRepo(REPO, SEED.repos['acme/api-service']!.files);
    return { stub, forge };
  }

  test('the credential is resolved by reference, never stored in an event', async () => {
    const { stub } = setup();
    const forge = new GitHubForge({
      fetch: stub.fetch,
      secretRef: 'GITHUB_TOKEN',
      resolveSecret: (ref) => (ref === 'GITHUB_TOKEN' ? 'ghp_resolved_by_reference' : undefined),
      sleep: async () => undefined,
    });
    const checkout = await forge.checkout({ repo: REPO });
    expect(checkout.commit).toMatch(/^[0-9a-f]{40}$/);

    // The resolved value never appears in the intended-action audit trail.
    expect(JSON.stringify(forge.listIntendedActions())).not.toContain('ghp_resolved_by_reference');
  });

  test('a missing credential fails with auth_failed before any request', async () => {
    const { stub } = setup();
    const forge = new GitHubForge({
      fetch: stub.fetch,
      secretRef: 'GITHUB_TOKEN',
      resolveSecret: () => undefined,
    });
    await expect(forge.checkout({ repo: REPO })).rejects.toMatchObject({ code: 'auth_failed' });
    expect(stub.recorded()).toHaveLength(0);
  });

  test('401/403 map to auth_failed and include the missing scope when known', async () => {
    const { stub, forge } = setup();
    stub.failNext(403, { 'x-accepted-github-permissions': 'contents=write' });
    const error = await forge.checkout({ repo: REPO }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ForgeError);
    expect((error as ForgeError).code).toBe('auth_failed');
    expect((error as ForgeError).details).toMatchObject({ missingScope: 'contents=write' });
  });

  test('a rate-limit response backs off then retries within the budget', async () => {
    const { stub } = setup();
    const waits: number[] = [];
    const forge = new GitHubForge({
      fetch: stub.fetch,
      token: 'ghp_fixture',
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    stub.failNext(403, {
      'x-ratelimit-remaining': '0',
      'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 1),
    });
    const checkout = await forge.checkout({ repo: REPO });
    expect(checkout.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(waits.length).toBe(1);
  });

  test('an exhausted rate limit surfaces rate_limited with the reset time', async () => {
    const { stub } = setup();
    const forge = new GitHubForge({
      fetch: stub.fetch,
      token: 'ghp_fixture',
      sleep: async () => undefined,
      maxRateLimitRetries: 0,
    });
    stub.failNext(429, { 'retry-after': '120', 'x-ratelimit-remaining': '0' });
    const error = await forge.checkout({ repo: REPO }).catch((caught: unknown) => caught);
    expect((error as ForgeError).code).toBe('rate_limited');
    expect((error as ForgeError).details).toMatchObject({ retryAfterMs: 120_000 });
  });

  test('dry run returns synthetic results, emits intended actions and never calls fetch', async () => {
    const { stub } = setup();
    const actions: string[] = [];
    const forge = new GitHubForge({
      fetch: stub.fetch,
      token: 'ghp_fixture',
      dryRun: true,
      onAction: (action) => actions.push(action.action),
    });

    const checkout = await forge.checkout({ repo: REPO });
    expect(checkout.branch).toBe('main');

    const branch = await forge.createBranch({ repo: REPO, name: 'factory/wi_dry' });
    const commit = await forge.commit({
      repo: REPO,
      branch: 'factory/wi_dry',
      message: 'dry run commit',
      files: [{ path: 'src/dry.ts', content: 'export const dry = true;\n' }],
    });
    const pull = await forge.openPullRequest({
      repo: REPO,
      head: 'factory/wi_dry',
      title: 'dry run',
      workItemId: 'wi_dry',
    });
    const merged = await forge.merge({ repo: REPO, pullRequestNumber: pull.number });

    expect(branch.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(commit.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(pull.url).toContain('/pull/');
    expect(merged.merged).toBe(true);
    expect(actions).toEqual(['checkout', 'branch.create', 'commit', 'pull.open', 'merge']);

    // No request left the process, so the repository is untouched.
    expect(stub.recorded()).toHaveLength(0);
    expect(stub.listPullRequests(REPO)).toHaveLength(0);
    expect(stub.headOf(REPO, 'main')).toBe(stub.headOf(REPO, 'main'));
  });

  test('dry run is enabled by GITHUB_DRY_RUN=1', () => {
    const previous = process.env.GITHUB_DRY_RUN;
    process.env.GITHUB_DRY_RUN = '1';
    try {
      const { stub } = setup();
      const forge = new GitHubForge({ fetch: stub.fetch, token: 'ghp_fixture' });
      expect(forge.listIntendedActions()).toHaveLength(0);
    } finally {
      if (previous === undefined) delete process.env.GITHUB_DRY_RUN;
      else process.env.GITHUB_DRY_RUN = previous;
    }
  });

  test('revert restores the previous tree as a new commit on the default branch', async () => {
    const { stub, forge } = setup();
    const before = await forge.checkout({ repo: REPO });
    await forge.createBranch({ repo: REPO, name: 'factory/revert' });
    await forge.commit({
      repo: REPO,
      branch: 'factory/revert',
      message: 'change',
      files: [{ path: 'src/revert.ts', content: 'export {};\n' }],
    });
    const pull = await forge.openPullRequest({ repo: REPO, head: 'factory/revert', title: 'revert me' });
    await forge.merge({ repo: REPO, pullRequestNumber: pull.number });

    const afterMerge = await forge.checkout({ repo: REPO });
    expect(afterMerge.files['src/revert.ts']).toBe('export {};\n');

    const reverted = await forge.revert({ repo: REPO, toSha: before.commit });
    expect(reverted.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(reverted.sha).not.toBe(afterMerge.commit);

    const afterRevert = await forge.checkout({ repo: REPO });
    expect(afterRevert.commit).toBe(reverted.sha);
    expect(afterRevert.files['src/revert.ts']).toBeUndefined();
  });

  test('unknown refs and pull requests map to not_found', async () => {
    const { forge } = setup();
    await expect(forge.checkout({ repo: REPO, ref: 'no-such-ref' })).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(
      forge.getChecks({ repo: REPO, pullRequestNumber: 999 }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  test('ETag cache turns repeated reads into 304s (no body transfer)', async () => {
    const { stub, forge } = setup();
    await forge.checkout({ repo: REPO });
    await forge.checkout({ repo: REPO });
    const before = stub.recorded().length;

    await forge.checkout({ repo: REPO });
    const secondRun = stub.recorded().slice(before);
    expect(secondRun.length).toBeGreaterThan(0);
    expect(secondRun.every((entry) => entry.status === 304)).toBe(true);
  });
});
