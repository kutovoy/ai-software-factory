import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadOrThrow,
  serializeDefinition,
  writeFiles,
  type CanaryRolloutRecord,
  type FactoryDefinition,
} from '@factory/core';
import { deployPromotion } from '../src/canary-apply';
import { loadConfig, type OrchestrationConfig } from '../src/config';

/**
 * Promotion hook + local checkout rewrite (harden-runtime, task 5.3/5.5; promotion
 * task 4.1/4.2). No database: the hook and the rewrite are exercised against materialised
 * definition trees, exactly the way `promoteCanaryRollout` calls them.
 */

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');
const dirs: string[] = [];
const previousRunsDir = process.env.RUNS_DIR;

function configFor(factoryRoot: string, runsDir: string): OrchestrationConfig {
  return loadConfig({ FACTORY_ROOT: factoryRoot, RUNS_DIR: runsDir });
}

function baseDefinition(): FactoryDefinition {
  return loadOrThrow(join(REPO_ROOT, 'factories', 'example'));
}

function candidateDefinition(description: string, hook?: string): FactoryDefinition {
  const base = baseDefinition();
  const improvement = {
    authority: 'canary' as const,
    canaryPercent: 10,
    rollbackThreshold: 0.1,
    observationWindowHours: 24,
    maxProbes: 3,
    ...(hook ? { deployHook: hook } : {}),
  };
  return {
    ...base,
    manifest: {
      ...base.manifest,
      description,
      improvement,
    },
  };
}

/** A materialised candidate tree, valid as a definition. */
async function tempTree(description: string, hook?: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'factory-deploy-'));
  dirs.push(dir);
  writeFiles(dir, serializeDefinition(candidateDefinition(description, hook)));
  return dir;
}

/** A non-git factory root holding a plain definition tree. */
async function tempNonGitFactoryRoot(description: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'factory-checkout-'));
  dirs.push(root);
  const factoryRoot = join(root, 'factories');
  writeFiles(join(factoryRoot, 'example'), serializeDefinition(candidateDefinition(description)));
  return factoryRoot;
}

/** A clean git worktree whose `factories/example` tree is committed. */
async function tempGitFactoryRoot(description: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'factory-checkout-git-'));
  dirs.push(root);
  writeFiles(join(root, 'factories', 'example'), serializeDefinition(candidateDefinition(description)));
  execFileSync('git', ['init'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] });
  execFileSync('git', ['config', 'user.email', 'canary@example.test'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Canary Test'], { cwd: root });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: root });
  execFileSync('git', ['add', '--', 'factories/example'], { cwd: root });
  execFileSync('git', ['commit', '-m', 'initial definition'], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return join(root, 'factories');
}

function rolloutFor(candidateRoot: string, id: string): CanaryRolloutRecord {
  return {
    id,
    factory: 'example',
    proposalId: 'prop_deploy_itest',
    candidateVersion: 'factory-v2-candidate',
    stableVersion: 'factory-v1',
    candidateCommit: 'a'.repeat(40),
    stableCommit: 'b'.repeat(40),
    candidateRoot,
    canaryPercent: 10,
    rollbackThreshold: 0.1,
    observationWindowHours: 24,
    status: 'promoted',
    reason: 'itest',
    prUrl: null,
    prNumber: null,
    actor: 'ada',
    evidence: {},
    deploymentStatus: null,
    deployedAt: null,
    deployHook: null,
    deployError: null,
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
  };
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  if (previousRunsDir === undefined) delete process.env.RUNS_DIR;
  else process.env.RUNS_DIR = previousRunsDir;
});

describe('promotion deployment hook', () => {
  test('runs the declared hook against the staged candidate and records `deployed`', async () => {
    const tree = await tempTree('candidate description', 'echo deployed > deploy.log');
    const runsDir = await mkdtemp(join(tmpdir(), 'factory-deploy-runs-'));
    dirs.push(runsDir);
    const factoryRoot = await tempNonGitFactoryRoot('stable description');

    const result = deployPromotion(rolloutFor(tree, 'canary_deploy_ok'), configFor(factoryRoot, runsDir));
    expect(result.status).toBe('deployed');
    expect(result.hook).toBe('echo deployed > deploy.log');
    expect(result.error).toBeNull();
    expect(result.stagedPath).toBeTruthy();
    expect(result.checkout.updated).toBe(false);
    expect(await readFile(join(result.stagedPath as string, 'deploy.log'), 'utf8')).toContain(
      'deployed',
    );
    // The staged tree is a real definition tree, not a marker file.
    expect(await readFile(join(result.stagedPath as string, 'factory.yaml'), 'utf8')).toContain(
      'name: example',
    );
  }, 30_000);

  test('a failing hook marks the rollout `promoted_pending_deploy` with the error', async () => {
    const tree = await tempTree('candidate description', 'echo hook failed >&2; exit 3');
    const runsDir = await mkdtemp(join(tmpdir(), 'factory-deploy-runs-'));
    dirs.push(runsDir);
    const factoryRoot = await tempNonGitFactoryRoot('stable description');

    const result = deployPromotion(rolloutFor(tree, 'canary_deploy_fail'), configFor(factoryRoot, runsDir));
    expect(result.status).toBe('promoted_pending_deploy');
    expect(result.hook).toBe('echo hook failed >&2; exit 3');
    expect(result.error).toBeTruthy();
    expect(result.stagedPath).toBeTruthy();
    expect(result.checkout.updated).toBe(false);
  }, 30_000);

  test('no hook in a non-git checkout records `promotion_pending_deploy` and does not claim the checkout was updated', async () => {
    const tree = await tempTree('candidate description');
    const runsDir = await mkdtemp(join(tmpdir(), 'factory-deploy-runs-'));
    dirs.push(runsDir);
    const factoryRoot = await tempNonGitFactoryRoot('stable description');

    const result = deployPromotion(
      rolloutFor(tree, 'canary_deploy_none'),
      configFor(factoryRoot, runsDir),
    );
    expect(result.status).toBe('promotion_pending_deploy');
    expect(result.hook).toBeNull();
    expect(result.error).toBeNull();
    expect(result.checkout.updated).toBe(false);
    expect(result.checkout.commit).toBeNull();
    expect(result.checkout.reason).toContain('not a git worktree');
    // The definition is still staged so a human/CI can install it deliberately.
    expect(result.stagedPath).toBeTruthy();
  }, 30_000);
});

describe('promotion local checkout rewrite', () => {
  test('rewrites a clean factory tree from the candidate and commits it locally', async () => {
    const tree = await tempTree('promoted candidate description');
    const runsDir = await mkdtemp(join(tmpdir(), 'factory-deploy-runs-'));
    dirs.push(runsDir);
    const factoryRoot = await tempGitFactoryRoot('stable description');
    const factoryPath = join(factoryRoot, 'example');

    const result = deployPromotion(
      rolloutFor(tree, 'canary_clean_rewrite'),
      configFor(factoryRoot, runsDir),
    );

    expect(result.status).toBe('deployed');
    expect(result.hook).toBeNull();
    expect(result.error).toBeNull();
    expect(result.checkout.updated).toBe(true);
    expect(result.checkout.reason).toBeNull();
    expect(result.checkout.error).toBeNull();
    expect(result.checkout.commit).toMatch(/^[0-9a-f]{40}$/);

    // The local tree now carries the candidate definition.
    expect(await readFile(join(factoryPath, 'factory.yaml'), 'utf8')).toContain(
      'promoted candidate description',
    );
    expect(
      execFileSync('git', ['status', '--porcelain', '--', 'factories/example'], {
        cwd: join(factoryRoot, '..'),
        encoding: 'utf8',
      }).trim(),
    ).toBe('');
    expect(
      execFileSync('git', ['log', '-1', '--format=%s'], {
        cwd: join(factoryRoot, '..'),
        encoding: 'utf8',
      }).trim(),
    ).toBe('factory: promote canary canary_clean_rewrite');
    expect(
      execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: join(factoryRoot, '..'),
        encoding: 'utf8',
      }).trim(),
    ).toBe(result.checkout.commit as string);
  }, 30_000);

  test('refuses to overwrite a dirty factory tree and records the reason', async () => {
    const tree = await tempTree('promoted candidate description');
    const runsDir = await mkdtemp(join(tmpdir(), 'factory-deploy-runs-'));
    dirs.push(runsDir);
    const factoryRoot = await tempGitFactoryRoot('stable description');
    const factoryPath = join(factoryRoot, 'example');
    const dirty = candidateDefinition('uncommitted operator edit');
    writeFiles(factoryPath, serializeDefinition(dirty));
    const headBefore = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: join(factoryRoot, '..'),
      encoding: 'utf8',
    }).trim();

    const result = deployPromotion(
      rolloutFor(tree, 'canary_dirty_refusal'),
      configFor(factoryRoot, runsDir),
    );

    expect(result.status).toBe('promotion_pending_deploy');
    expect(result.hook).toBeNull();
    expect(result.error).toBeNull();
    expect(result.checkout.updated).toBe(false);
    expect(result.checkout.commit).toBeNull();
    expect(result.checkout.reason).toContain('uncommitted changes');
    // The operator's uncommitted tree is untouched.
    expect(await readFile(join(factoryPath, 'factory.yaml'), 'utf8')).toContain(
      'uncommitted operator edit',
    );
    expect(
      execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: join(factoryRoot, '..'),
        encoding: 'utf8',
      }).trim(),
    ).toBe(headBefore);
  }, 30_000);
});
