import { describe, expect, test } from 'bun:test';
import { ForgeError, isForgeError, type ForgeErrorCode } from './errors';
import type { CodeForge, PullRequest, RepoRef } from './types';

/**
 * Shared contract for every `CodeForge` backend (fake now, GitHub in 3b).
 *
 * A backend must pass this suite unchanged: the loop's activities are written against the
 * interface, so a divergence here is a production bug, not a test detail.
 */

export interface CodeForgeContractOptions {
  /**
   * Creates the contract repo (`acme/api-service`) with a default branch and one file.
   * The fake backend seeds itself; a real backend points at a fixture repository.
   */
  setup?: (forge: CodeForge) => void | Promise<void>;
  /** Repo used by the suite. Defaults to `acme/api-service`. */
  repo?: RepoRef;
  /**
   * Makes the checks for a pull request red deterministically. Optional: a transport that
   * cannot simulate checks (real GitHub) skips the merge-refusal case.
   */
  redChecks?: (forge: CodeForge, repo: RepoRef, pullRequestNumber: number) => void | Promise<void>;
}

const DEFAULT_REPO: RepoRef = { owner: 'acme', name: 'api-service' };

function expectForgeError(fn: () => Promise<unknown>, code: ForgeErrorCode): Promise<void> {
  return fn().then(
    () => {
      throw new Error(`expected ForgeError(${code}), the call succeeded`);
    },
    (error: unknown) => {
      expect(isForgeError(error)).toBe(true);
      expect((error as ForgeError).code).toBe(code);
    },
  );
}

export function runCodeForgeContractTests(
  backendId: string,
  makeForge: () => CodeForge,
  options: CodeForgeContractOptions = {},
): void {
  const repo = options.repo ?? DEFAULT_REPO;

  async function forge(): Promise<CodeForge> {
    const created = makeForge();
    await options.setup?.(created);
    return created;
  }

  describe(`CodeForge contract — ${backendId}`, () => {
    test('checkout resolves the default branch head and returns a file snapshot', async () => {
      const backend = await forge();
      const checkout = await backend.checkout({ repo });
      expect(checkout.commit).toMatch(/^[0-9a-f]{40}$/);
      expect(typeof checkout.branch).toBe('string');
      expect(Object.keys(checkout.files).length).toBeGreaterThan(0);
    });

    test('createBranch + commit produce a new SHA on the branch only', async () => {
      const backend = await forge();
      const before = await backend.checkout({ repo });
      const branch = await backend.createBranch({ repo, name: 'factory/wi_1' });
      expect(branch.commit).toBe(before.commit);

      const commit = await backend.commit({
        repo,
        branch: 'factory/wi_1',
        message: 'implement work item',
        files: [{ path: 'src/retry.ts', content: 'export const retry = 3;\n' }],
      });
      expect(commit.sha).toMatch(/^[0-9a-f]{40}$/);
      expect(commit.sha).not.toBe(before.commit);

      const onBranch = await backend.checkout({ repo, ref: 'factory/wi_1' });
      expect(onBranch.files['src/retry.ts']).toBe('export const retry = 3;\n');

      // The default branch did not move.
      const main = await backend.checkout({ repo });
      expect(main.commit).toBe(before.commit);
    });

    test('commits to the default branch are rejected with protected_branch', async () => {
      const backend = await forge();
      const checkout = await backend.checkout({ repo });
      await expectForgeError(
        () =>
          backend.commit({
            repo,
            branch: checkout.branch,
            message: 'sneaky push',
            files: [{ path: 'README.md', content: 'hacked\n' }],
          }),
        'protected_branch',
      );
    });

    test('creating a branch named like the default branch is rejected', async () => {
      const backend = await forge();
      const checkout = await backend.checkout({ repo });
      await expectForgeError(
        () => backend.createBranch({ repo, name: checkout.branch }),
        'protected_branch',
      );
    });

    test('openPullRequest is idempotent for the same head and work item', async () => {
      const backend = await forge();
      await backend.createBranch({ repo, name: 'factory/wi_2' });
      await backend.commit({
        repo,
        branch: 'factory/wi_2',
        message: 'change',
        files: [{ path: 'a.txt', content: 'a\n' }],
      });

      const first = await backend.openPullRequest({
        repo,
        head: 'factory/wi_2',
        title: 'Work item wi_2',
        body: 'Implements wi_2',
        workItemId: 'wi_2',
      });
      const second = await backend.openPullRequest({
        repo,
        head: 'factory/wi_2',
        title: 'Work item wi_2',
        body: 'Implements wi_2',
        workItemId: 'wi_2',
      });

      expect(first.number).toBe(second.number);
      expect(first.url).toContain('/pull/');
      expect(first.state).toBe('open');
      expect(first.workItemId).toBe('wi_2');
    });

    test('comment is attached to an existing pull request', async () => {
      const backend = await forge();
      const pull = await openPull(backend, repo, 'factory/wi_3');
      const comment = await backend.comment({
        repo,
        pullRequestNumber: pull.number,
        body: 'advisory review findings',
      });
      expect(comment.pullRequestNumber).toBe(pull.number);
      expect(comment.body).toBe('advisory review findings');
      await expectForgeError(
        () => backend.comment({ repo, pullRequestNumber: 9999, body: 'nowhere' }),
        'not_found',
      );
    });

    test('checks default to green for a fresh pull request', async () => {
      const backend = await forge();
      const pull = await openPull(backend, repo, 'factory/wi_4');
      const checks = await backend.getChecks({ repo, pullRequestNumber: pull.number });
      expect(checks.green).toBe(true);
      expect(checks.checks.length).toBeGreaterThan(0);
      expect(checks.checks.every((check) => check.conclusion === 'success')).toBe(true);
    });

    test('merge advances the default branch and closes the pull request', async () => {
      const backend = await forge();
      const before = await backend.checkout({ repo });
      const pull = await openPull(backend, repo, 'factory/wi_5');

      const merged = await backend.merge({ repo, pullRequestNumber: pull.number });
      expect(merged.merged).toBe(true);
      expect(merged.pullRequest.state).toBe('merged');
      expect(merged.sha).toMatch(/^[0-9a-f]{40}$/);

      const after = await backend.checkout({ repo });
      expect(after.commit).toBe(merged.sha as string);
      expect(after.commit).not.toBe(before.commit);

      await expectForgeError(
        () => backend.merge({ repo, pullRequestNumber: pull.number }),
        'invalid_state',
      );
    });

    if (options.redChecks) {
      test('merge is refused when checks are red', async () => {
        const backend = await forge();
        const pull = await openPull(backend, repo, 'factory/wi_6');
        await options.redChecks!(backend, repo, pull.number);

        const checks = await backend.getChecks({ repo, pullRequestNumber: pull.number });
        expect(checks.green).toBe(false);

        await expectForgeError(
          () => backend.merge({ repo, pullRequestNumber: pull.number }),
          'checks_not_green',
        );
      });
    }

    test('unknown repos, branches and refs fail with not_found', async () => {
      const backend = await forge();
      await expectForgeError(
        () => backend.checkout({ repo: { owner: 'nobody', name: 'nothing' } }),
        'not_found',
      );
      await expectForgeError(() => backend.checkout({ repo, ref: 'no-such-ref' }), 'not_found');
      await expectForgeError(
        () =>
          backend.commit({
            repo,
            branch: 'no-such-branch',
            message: 'x',
            files: [],
          }),
        'not_found',
      );
    });
  });
}

async function openPull(backend: CodeForge, repo: RepoRef, branch: string): Promise<PullRequest> {
  await backend.createBranch({ repo, name: branch });
  await backend.commit({
    repo,
    branch,
    message: `change for ${branch}`,
    files: [{ path: `changes/${branch}.txt`, content: `${branch}\n` }],
  });
  return await backend.openPullRequest({
    repo,
    head: branch,
    title: `Work item ${branch}`,
    body: `Implements ${branch}`,
    workItemId: branch,
  });
}
