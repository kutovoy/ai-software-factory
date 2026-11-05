import { describe, expect, test } from 'bun:test';
import { repoSpecForRun } from '../src/activities/runner';
import type { RunInput } from '../src/types';

/**
 * Regression for the live macOS remote-runner E2E: `leaseRunner` used to send both the
 * central checkout path and the remote clone URL. `normalizeRunnerSpec` rejects that
 * combination, so every remote run failed at lease before reaching the agent.
 */

function input(overrides: Partial<RunInput> = {}): RunInput {
  return {
    runId: 'run_test',
    factory: 'hello-nextjs',
    factoryRoot: '/repo/factories/hello-nextjs',
    definitionCommit: 'abc123',
    definitionDirty: false,
    harness: 'opencode',
    runner: 'remote',
    repo: { url: 'file:///repo', commit: 'def456' },
    prompt: null,
    kind: 'chat',
    proxyModels: [],
    ...overrides,
  };
}

describe('repoSpecForRun', () => {
  test('remote runs send only the clone URL, never the central path', () => {
    const repo = repoSpecForRun(input());
    expect(repo).toEqual({ url: 'file:///repo', commit: 'def456' });
    expect(repo).not.toHaveProperty('path');
  });

  test('remote work items fall back to RUNNER_REPO_URL when the input has only a path', () => {
    const repo = repoSpecForRun(
      input({ repo: { path: '/repo' } }),
      undefined,
      undefined,
      'file:///repo',
    );
    expect(repo).toEqual({ url: 'file:///repo', commit: 'abc123' });
    expect(repo).not.toHaveProperty('path');
  });

  test('remote runs carry an upstream patch as content, not a host path', () => {
    const repo = repoSpecForRun(input(), '/central/runs/run_x/patch.diff', 'diff --git a/x b/x');
    expect(repo).toEqual({
      url: 'file:///repo',
      commit: 'def456',
      patchContent: 'diff --git a/x b/x',
    });
    expect(repo).not.toHaveProperty('path');
    expect(repo).not.toHaveProperty('patch');
  });

  test('local runs keep the central path and may apply a host patch file', () => {
    const repo = repoSpecForRun(
      input({
        runner: 'local-docker',
        repo: { path: '/repo', commit: 'def456' },
      }),
      '/central/runs/run_x/patch.diff',
    );
    expect(repo).toEqual({
      path: '/repo',
      commit: 'def456',
      patch: '/central/runs/run_x/patch.diff',
    });
    expect(repo).not.toHaveProperty('url');
  });

  test('local runs fall back to the factory root and definition commit', () => {
    const repo = repoSpecForRun(input({ runner: 'local-process', repo: undefined }));
    expect(repo).toEqual({
      path: '/repo/factories/hello-nextjs',
      commit: 'abc123',
    });
  });
});
