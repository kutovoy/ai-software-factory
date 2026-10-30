import { afterEach, describe, expect, test } from 'bun:test';
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

/**
 * Promotion hook (harden-runtime, task 5.3/5.5). No database: the hook is exercised against
 * a materialised definition tree, exactly the way `promoteCanaryRollout` calls it.
 */

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');
const dirs: string[] = [];
const previousRunsDir = process.env.RUNS_DIR;

async function tempTree(hook?: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'factory-deploy-'));
  dirs.push(dir);
  const base: FactoryDefinition = loadOrThrow(join(REPO_ROOT, 'factories', 'example'));
  const definition: FactoryDefinition = {
    ...base,
    manifest: {
      ...base.manifest,
      improvement: {
        authority: 'canary',
        canaryPercent: 10,
        rollbackThreshold: 0.1,
        observationWindowHours: 24,
        maxProbes: 3,
        ...(hook ? { deployHook: hook } : {}),
      },
    },
  };
  writeFiles(dir, serializeDefinition(definition));
  return dir;
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
    const tree = await tempTree('echo deployed > deploy.log');
    const runsDir = await mkdtemp(join(tmpdir(), 'factory-deploy-runs-'));
    dirs.push(runsDir);
    process.env.RUNS_DIR = runsDir;

    const result = deployPromotion(rolloutFor(tree, 'canary_deploy_ok'));
    expect(result.status).toBe('deployed');
    expect(result.hook).toBe('echo deployed > deploy.log');
    expect(result.error).toBeNull();
    expect(result.stagedPath).toBeTruthy();
    expect(await readFile(join(result.stagedPath as string, 'deploy.log'), 'utf8')).toContain(
      'deployed',
    );
    // The staged tree is a real definition tree, not a marker file.
    expect(await readFile(join(result.stagedPath as string, 'factory.yaml'), 'utf8')).toContain(
      'name: example',
    );
  }, 30_000);

  test('a failing hook marks the rollout `promoted_pending_deploy` with the error', async () => {
    const tree = await tempTree('echo hook failed >&2; exit 3');
    const runsDir = await mkdtemp(join(tmpdir(), 'factory-deploy-runs-'));
    dirs.push(runsDir);
    process.env.RUNS_DIR = runsDir;

    const result = deployPromotion(rolloutFor(tree, 'canary_deploy_fail'));
    expect(result.status).toBe('promoted_pending_deploy');
    expect(result.hook).toBe('echo hook failed >&2; exit 3');
    expect(result.error).toBeTruthy();
    expect(result.stagedPath).toBeTruthy();
  }, 30_000);

  test('no hook records `promotion_pending_deploy` and does not claim the checkout was updated', async () => {
    const tree = await tempTree();
    const runsDir = await mkdtemp(join(tmpdir(), 'factory-deploy-runs-'));
    dirs.push(runsDir);
    process.env.RUNS_DIR = runsDir;

    const result = deployPromotion(rolloutFor(tree, 'canary_deploy_none'));
    expect(result.status).toBe('promotion_pending_deploy');
    expect(result.hook).toBeNull();
    expect(result.error).toBeNull();
    // The definition is still staged so a human/CI can install it deliberately.
    expect(result.stagedPath).toBeTruthy();
  }, 30_000);
});
