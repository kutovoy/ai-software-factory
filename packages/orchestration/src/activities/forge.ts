import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ApplicationFailure } from '@temporalio/activity';
import {
  FakeForge,
  ForgeError,
  repoKey,
  type ChecksResult,
  type CodeForge,
  type Comment,
  type FileChange,
  type MergeResult,
  type RepoRef,
} from '@factory/forge';
import { loadDefinition } from '@factory/core';
import { loadConfig } from '../config';

/**
 * Forge activities — the only place the loop touches a repository.
 *
 * Phase 3a runs on the in-memory `FakeForge`: no network, no credentials, deterministic.
 * Phase 3b swaps in the GitHub backend behind the same `CodeForge` interface; nothing in
 * the workflow changes.
 *
 * Forge errors are stable codes (`protected_branch`, `checks_not_green`, ...) and become
 * non-retryable Temporal failures, so a rejected write fails the stage instead of being
 * retried forever.
 */

const forges = new Map<string, CodeForge>();
let defaultForge: CodeForge | null = null;

/** Test hook: install a backend (e.g. a pre-seeded `FakeForge`). */
export function setForge(id: string, forge: CodeForge | null): void {
  if (forge === null) forges.delete(id);
  else forges.set(id, forge);
}

export function getForge(id = process.env.CODE_FORGE ?? 'fake'): CodeForge {
  const existing = forges.get(id);
  if (existing) return existing;
  if (id !== 'fake') {
    throw ApplicationFailure.create({
      type: 'forge_unavailable',
      nonRetryable: true,
      message: `code forge "${id}" has no backend yet (3b); use CODE_FORGE=fake`,
      details: [{ backend: id }],
    });
  }
  defaultForge ??= new FakeForge();
  return defaultForge;
}

function factoryRepo(factoryRoot: string, factory: string): RepoRef {
  const { definition, errors } = loadDefinition(factoryRoot);
  if (!definition) {
    throw ApplicationFailure.create({
      type: 'definition_invalid',
      nonRetryable: true,
      message: `factory "${factory}" does not validate: ${errors
        .map((error) => `${error.code} ${error.pointer}`)
        .join(', ')}`,
      details: [{ factory, errors }],
    });
  }
  const repository = definition.manifest.repositories[0];
  if (!repository) {
    throw ApplicationFailure.create({
      type: 'invalid_repository',
      nonRetryable: true,
      message: `factory "${factory}" declares no repository`,
      details: [{ factory }],
    });
  }
  return { owner: repository.owner, name: repository.name };
}

function asForgeFailure(error: unknown): never {
  if (error instanceof ForgeError) {
    throw ApplicationFailure.create({
      type: error.code,
      nonRetryable: true,
      message: error.message,
      details: [error.details ?? {}],
    });
  }
  throw error;
}

/** The fake backend starts empty; seed the factory repo the first time it is used. */
function ensureSeeded(forge: CodeForge, repo: RepoRef): void {
  if (forge instanceof FakeForge) {
    forge.seedRepo(repo, {
      'README.md': `# ${repo.name}\n\nManaged by the factory loop (fake forge).\n`,
    });
  }
}

export interface OpenPullRequestArgs {
  workItemId: string;
  factory: string;
  factoryRoot: string;
  title: string;
  body: string;
  /** Run whose `patch.diff` is committed (the implement stage run). */
  runId: string;
  base?: string;
}

export interface OpenPullRequestResult {
  prUrl: string;
  prNumber: number;
  branch: string;
  commit: string;
  repo: string;
}

/**
 * Creates the branch, commits the run's patch and opens a pull request referencing the
 * work item (spec: forge abstraction / branch and PR). Never touches the default branch.
 */
export async function forgeOpenPullRequest(
  args: OpenPullRequestArgs,
): Promise<OpenPullRequestResult> {
  const repo = factoryRepo(args.factoryRoot, args.factory);
  const forge = getForge();
  ensureSeeded(forge, repo);

  const branch = `factory/${args.workItemId}`;
  const patch = await readPatch(args.runId);
  const files: FileChange[] = [
    { path: `changes/${args.workItemId}.patch`, content: patch },
  ];

  try {
    await forge.createBranch({ repo, name: branch });
    const commit = await forge.commit({
      repo,
      branch,
      message: `factory: ${args.workItemId} — ${args.title}`,
      files,
    });
    const pull = await forge.openPullRequest({
      repo,
      head: branch,
      ...(args.base ? { base: args.base } : {}),
      title: args.title,
      body: args.body,
      workItemId: args.workItemId,
    });

    return {
      prUrl: pull.url,
      prNumber: pull.number,
      branch,
      commit: commit.sha,
      repo: repoKey(repo),
    };
  } catch (error) {
    return asForgeFailure(error);
  }
}

export async function forgeMergePullRequest(args: {
  factory: string;
  factoryRoot: string;
  pullRequestNumber: number;
  method?: 'merge' | 'squash' | 'rebase';
}): Promise<MergeResult> {
  const repo = factoryRepo(args.factoryRoot, args.factory);
  const forge = getForge();
  ensureSeeded(forge, repo);
  try {
    return await forge.merge({
      repo,
      pullRequestNumber: args.pullRequestNumber,
      ...(args.method ? { method: args.method } : {}),
    });
  } catch (error) {
    return asForgeFailure(error);
  }
}

export async function forgeGetChecks(args: {
  factory: string;
  factoryRoot: string;
  pullRequestNumber: number;
}): Promise<ChecksResult> {
  const repo = factoryRepo(args.factoryRoot, args.factory);
  const forge = getForge();
  ensureSeeded(forge, repo);
  try {
    return await forge.getChecks({ repo, pullRequestNumber: args.pullRequestNumber });
  } catch (error) {
    return asForgeFailure(error);
  }
}

/** Plain comment (findings only). Approvals are never posted by the loop. */
export async function forgeComment(args: {
  factory: string;
  factoryRoot: string;
  pullRequestNumber: number;
  body: string;
  author?: string;
}): Promise<Comment> {
  const repo = factoryRepo(args.factoryRoot, args.factory);
  const forge = getForge();
  ensureSeeded(forge, repo);
  try {
    return await forge.comment({
      repo,
      pullRequestNumber: args.pullRequestNumber,
      body: args.body,
      ...(args.author ? { author: args.author } : {}),
    });
  } catch (error) {
    return asForgeFailure(error);
  }
}

/** Reads the run's captured patch, or synthesises a placeholder when there is none. */
async function readPatch(runId: string): Promise<string> {
  const { runsDir } = loadConfig();
  try {
    return await readFile(join(runsDir, runId, 'patch.diff'), 'utf8');
  } catch {
    return `# factory stage patch placeholder for ${runId}\n`;
  }
}
