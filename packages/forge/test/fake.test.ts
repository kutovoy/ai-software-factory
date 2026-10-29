import { describe, expect, test } from 'bun:test';
import { FakeForge } from '../src/fake';
import { runCodeForgeContractTests } from '../src/contract';
import type { RepoRef } from '../src/types';

const REPO: RepoRef = { owner: 'acme', name: 'api-service' };

runCodeForgeContractTests(
  'fake',
  () => new FakeForge(),
  {
    setup: (forge) => {
      (forge as FakeForge).seedRepo(REPO, {
        'README.md': '# api-service\n',
        'src/index.ts': 'export {};\n',
      });
    },
    redChecks: (forge, repo, pullRequestNumber) => {
      (forge as FakeForge).simulateChecks(repo, pullRequestNumber, [
        { name: 'ci', conclusion: 'failure' },
      ]);
    },
  },
);

describe('fake forge specifics', () => {
  test('deterministic red checks are reproducible', async () => {
    const forge = new FakeForge();
    forge.seedRepo(REPO, { 'README.md': '# api-service\n' });

    const run = async (): Promise<string[]> => {
      const branch = 'factory/red';
      await forge.createBranch({ repo: REPO, name: branch });
      await forge.commit({
        repo: REPO,
        branch,
        message: 'change',
        files: [{ path: 'a.txt', content: 'a\n' }],
      });
      const pull = await forge.openPullRequest({
        repo: REPO,
        head: branch,
        title: 'Work item [red]',
      });
      const checks = await forge.getChecks({ repo: REPO, pullRequestNumber: pull.number });
      return checks.checks.map((check) => `${check.name}:${check.conclusion}`);
    };

    const first = await run();
    expect(first).toContain('ci:failure');

    // Same inputs → same outcome on a fresh backend.
    const fresh = new FakeForge();
    fresh.seedRepo(REPO, { 'README.md': '# api-service\n' });
    const second = await (async () => {
      await fresh.createBranch({ repo: REPO, name: 'factory/red' });
      await fresh.commit({
        repo: REPO,
        branch: 'factory/red',
        message: 'change',
        files: [{ path: 'a.txt', content: 'a\n' }],
      });
      const pull = await fresh.openPullRequest({
        repo: REPO,
        head: 'factory/red',
        title: 'Work item [red]',
      });
      return (await fresh.getChecks({ repo: REPO, pullRequestNumber: pull.number })).checks.map(
        (check) => `${check.name}:${check.conclusion}`,
      );
    })();
    expect(second).toEqual(first);
  });

  test('comments are kept per pull request', async () => {
    const forge = new FakeForge();
    forge.seedRepo(REPO, { 'README.md': '# api-service\n' });
    await forge.createBranch({ repo: REPO, name: 'factory/one' });
    await forge.commit({
      repo: REPO,
      branch: 'factory/one',
      message: 'one',
      files: [{ path: 'one.txt', content: '1\n' }],
    });
    const pull = await forge.openPullRequest({ repo: REPO, head: 'factory/one', title: 'one' });
    await forge.comment({ repo: REPO, pullRequestNumber: pull.number, body: 'first' });
    expect(forge.listComments(REPO, pull.number)).toHaveLength(1);
  });
});
