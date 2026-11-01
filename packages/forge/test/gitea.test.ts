import { describe, expect, test } from 'bun:test';
import { GitHubForge, type GithubFetch, type GithubResponseLike } from '../src/github';
import type { RepoRef } from '../src/types';

/**
 * Gitea/Forgejo dialect (spec `code-forge` › API compatibility).
 *
 * The GitHub client is reused against a local forge through `GITHUB_API_BASE_URL`. Gitea
 * differs on refs, branch creation, commits, checks and merge; these tests pin the exact
 * requests the client sends so a future refactor cannot silently go back to GitHub paths.
 * They use a recording transport (no network).
 */

const REPO: RepoRef = { owner: 'acme', name: 'api-service' };
const BASE = 'http://forgejo:3000/api/v1';
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

interface RecordedCall {
  method: string;
  path: string;
  body?: unknown;
}

function ok(body: unknown, status = 200): GithubResponseLike {
  return { ok: true, status, headers: { get: () => null }, json: async () => body };
}

function err(status: number): GithubResponseLike {
  return { ok: false, status, headers: { get: () => null }, json: async () => ({}) };
}

function recorder(handler: (call: RecordedCall) => GithubResponseLike): {
  fetch: GithubFetch;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const fetch: GithubFetch = async (url, init) => {
    const call: RecordedCall = {
      method: init?.method ?? 'GET',
      path: url.replace(BASE, ''),
      ...(init?.body === undefined ? {} : { body: JSON.parse(init.body) }),
    };
    calls.push(call);
    return handler(call);
  };
  return { fetch, calls };
}

function gitea(handler: (call: RecordedCall) => GithubResponseLike): GitHubForge {
  return new GitHubForge({ baseUrl: BASE, token: 'forgejo_token', fetch: recorder(handler).fetch });
}

describe('gitea dialect', () => {
  test('createBranch uses POST /branches with Gitea branch fields', async () => {
    const { fetch, calls } = recorder((call) => {
      if (call.path === '/repos/acme/api-service') return ok({ default_branch: 'main' });
      if (call.path === '/repos/acme/api-service/git/refs/heads/main') {
        return ok([{ ref: 'refs/heads/main', object: { sha: SHA_A } }]);
      }
      if (call.path === '/repos/acme/api-service/git/refs/heads/factory/wi_1') return err(404);
      if (call.path === '/repos/acme/api-service/branches' && call.method === 'POST') {
        return ok({ name: 'factory/wi_1', commit: { id: SHA_A } }, 201);
      }
      return err(404);
    });
    const forge = new GitHubForge({ baseUrl: BASE, token: 't', fetch });

    const branch = await forge.createBranch({ repo: REPO, name: 'factory/wi_1' });
    expect(branch).toEqual({ repo: REPO, name: 'factory/wi_1', commit: SHA_A });

    const create = calls.find((call) => call.method === 'POST' && call.path.endsWith('/branches'));
    expect(create?.body).toEqual({ new_branch_name: 'factory/wi_1', old_branch_name: 'main' });
    // GitHub's ref endpoints are never touched.
    expect(calls.some((call) => call.path.includes('/git/ref/heads/'))).toBe(false);
    expect(calls.some((call) => call.method === 'POST' && call.path.includes('/git/refs'))).toBe(false);
  });

  test('commit writes files through the contents API (no git blob/tree/commit writes)', async () => {
    const content = Buffer.from('export const retry = 3;\n', 'utf8').toString('base64');
    const { fetch, calls } = recorder((call) => {
      if (call.path === '/repos/acme/api-service') return ok({ default_branch: 'main' });
      if (call.path === '/repos/acme/api-service/git/refs/heads/factory/wi_1') {
        return ok([{ ref: 'refs/heads/factory/wi_1', object: { sha: SHA_A } }]);
      }
      if (call.path === '/repos/acme/api-service/contents/src/retry.ts?ref=factory%2Fwi_1') return err(404);
      if (call.path === '/repos/acme/api-service/contents/src/retry.ts' && call.method === 'POST') {
        return ok({ commit: { sha: SHA_B } }, 201);
      }
      if (call.path === `/repos/acme/api-service/git/trees/${SHA_B}?recursive=1`) {
        return ok({ sha: SHA_B, tree: [{ path: 'src/retry.ts', type: 'blob', mode: '100644', sha: 'c' }] });
      }
      if (call.path === '/repos/acme/api-service/git/blobs/c') {
        return ok({ content, encoding: 'base64' });
      }
      return err(404);
    });
    const forge = new GitHubForge({ baseUrl: BASE, token: 't', fetch });

    const commit = await forge.commit({
      repo: REPO,
      branch: 'factory/wi_1',
      message: 'implement work item',
      files: [{ path: 'src/retry.ts', content: 'export const retry = 3;\n' }],
    });

    expect(commit.sha).toBe(SHA_B);
    expect(commit.files['src/retry.ts']).toBe('export const retry = 3;\n');
    const write = calls.find((call) => call.method === 'POST' && call.path.endsWith('/contents/src/retry.ts'));
    expect(write?.body).toMatchObject({ branch: 'factory/wi_1', content });
    expect(calls.some((call) => call.path.includes('/git/blobs') && call.method === 'POST')).toBe(false);
    expect(calls.some((call) => call.path.includes('/git/trees') && call.method === 'POST')).toBe(false);
    expect(calls.some((call) => call.path.includes('/git/commits') && call.method === 'POST')).toBe(false);
  });

  test('getChecks maps commit statuses; an empty status set is green', async () => {
    const pull = { head: { sha: SHA_A, ref: 'factory/wi_1' } };
    const red = gitea((call) => {
      if (call.path === '/repos/acme/api-service/pulls/1') return ok(pull);
      if (call.path === `/repos/acme/api-service/commits/${SHA_A}/status`) {
        return ok({
          state: 'failure',
          statuses: [{ status: 'failure', context: 'ci', target_url: 'http://forgejo/acme/api-service/actions' }],
        });
      }
      return err(404);
    });
    const redChecks = await red.getChecks({ repo: REPO, pullRequestNumber: 1 });
    expect(redChecks.green).toBe(false);
    expect(redChecks.checks[0]).toEqual({
      name: 'ci',
      conclusion: 'failure',
      url: 'http://forgejo/acme/api-service/actions',
    });

    const empty = gitea((call) => {
      if (call.path === '/repos/acme/api-service/pulls/1') return ok(pull);
      if (call.path === `/repos/acme/api-service/commits/${SHA_A}/status`) {
        return ok({ state: '', statuses: null });
      }
      return err(404);
    });
    const noChecks = await empty.getChecks({ repo: REPO, pullRequestNumber: 1 });
    expect(noChecks.green).toBe(true);
    expect(noChecks.checks).toEqual([]);
  });

  test('merge uses POST with `Do` and reports the merge commit', async () => {
    const { fetch, calls } = recorder((call) => {
      if (call.path === '/repos/acme/api-service/pulls/7' && call.method === 'GET') {
        return ok({
          number: 7,
          html_url: 'http://localhost:3000/extras/forgejo/acme/api-service/pulls/7',
          state: calls.filter((entry) => entry.method === 'POST').length > 0 ? 'closed' : 'open',
          title: 'Work item',
          body: '',
          head: { ref: 'factory/wi_1', sha: SHA_A },
          base: { ref: 'main' },
          created_at: '2026-11-01T00:00:00Z',
          merged: calls.filter((entry) => entry.method === 'POST').length > 0,
          merged_at: calls.filter((entry) => entry.method === 'POST').length > 0 ? '2026-11-01T00:01:00Z' : null,
          merge_commit_sha: SHA_B,
        });
      }
      if (call.path === '/repos/acme/api-service/pulls/7/merge' && call.method === 'POST') {
        return ok({});
      }
      return err(404);
    });
    const forge = new GitHubForge({ baseUrl: BASE, token: 't', fetch });

    const merged = await forge.merge({ repo: REPO, pullRequestNumber: 7, method: 'squash' });
    expect(merged.merged).toBe(true);
    expect(merged.sha).toBe(SHA_B);
    expect(merged.pullRequest.state).toBe('merged');
    const call = calls.find((entry) => entry.path.endsWith('/pulls/7/merge'));
    expect(call?.method).toBe('POST');
    expect(call?.body).toEqual({ Do: 'squash' });
  });
});
