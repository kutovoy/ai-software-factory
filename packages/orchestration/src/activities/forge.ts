import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ApplicationFailure } from '@temporalio/activity';
import {
  FakeForge,
  ForgeError,
  githubForgeFromEnv,
  repoKey,
  type ChecksResult,
  type CodeForge,
  type Comment,
  type MergeResult,
  type RepoRef,
} from '@factory/forge';
import {
  appendWorkItemEvent,
  getIntegration,
  loadDefinition,
  runGuardHooks,
  type GuardReport,
} from '@factory/core';
import { loadConfig } from '../config';
import { getSql } from '../db';
import { applyPatch, PatchError } from './patch';

/**
 * Forge activities — the only place the loop touches a repository.
 *
 * Phase 3a runs on the in-memory `FakeForge`: no network, no credentials, deterministic.
 * Phase 3b swaps in the GitHub backend behind the same `CodeForge` interface; nothing in
 * the workflow changes.
 *
 * `add-forgejo` adds a second real dialect: the same client talks to a local Forgejo/Gitea
 * (`GITHUB_API_BASE_URL`, ADR-032). Which backend a factory uses is decided by its stored
 * integration: an enabled, non-dry-run GitHub connection whose secret resolves uses the
 * real forge; every other factory keeps the fake backend, so `scripts/smoke.sh` and CI
 * stay credential-free. `CODE_FORGE` still overrides both.
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

export function getForge(
  id = process.env.CODE_FORGE ?? 'fake',
  options: { secretRef?: string } = {},
): CodeForge {
  // A real backend is cached per secret reference: two factories may point at different
  // tokens for the same forge.
  const key = id === 'github' && options.secretRef ? `github:${options.secretRef}` : id;
  const existing = forges.get(key);
  if (existing) return existing;
  if (id === 'github') {
    const forge = githubForgeFromEnv({
      secretRef: options.secretRef ?? process.env.GITHUB_SECRET_REF ?? 'GITHUB_TOKEN',
    });
    forges.set(key, forge);
    return forge;
  }
  if (id !== 'fake') {
    throw ApplicationFailure.create({
      type: 'forge_unavailable',
      nonRetryable: true,
      message: `code forge "${id}" has no backend; use CODE_FORGE=fake or CODE_FORGE=github`,
      details: [{ backend: id }],
    });
  }
  defaultForge ??= new FakeForge();
  return defaultForge;
}

/**
 * Resolves the backend a factory actually uses. `CODE_FORGE` (and the test hook) win;
 * otherwise the factory's stored integration decides: enabled, not a dry run, and a token
 * that resolves in this process. Everything else is the fake forge, so a factory that
 * declares no connection never pretends to have pushed anywhere.
 */
export async function resolveForge(factory: string): Promise<CodeForge> {
  const explicit = process.env.CODE_FORGE;
  if (explicit) return getForge(explicit);

  const testHook = forges.get('fake');
  if (testHook) return testHook;

  const baseUrl = process.env.GITHUB_API_BASE_URL;
  const databaseUrl = process.env.DATABASE_URL;
  if (!baseUrl || !databaseUrl) return getForge('fake');

  try {
    const integration = await getIntegration(getSql(databaseUrl), factory, 'github');
    if (!integration || !integration.enabled || integration.dryRun) return getForge('fake');
    // The token is resolved by name from this process's environment (ADR-026); a name
    // that does not resolve is a configuration gap, not a reason to hit the network.
    if (!process.env[integration.secretRef]) return getForge('fake');
    return getForge('github', { secretRef: integration.secretRef });
  } catch {
    return getForge('fake');
  }
}

export function factoryRepo(factoryRoot: string, factory: string): RepoRef {
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

/** Patch failures are non-retryable: retrying the same stale diff cannot succeed. */
function asPatchFailure(error: unknown): never {
  if (error instanceof PatchError) {
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
 * Records a guard verdict in the read model. Best effort: the verdict itself (fail-closed)
 * governs the PR, so a database-less environment (CI, the fake-forge suite) still exercises
 * the forge path without silently changing the outcome.
 */
async function recordGuardEvent(
  workItemId: string,
  type: 'guard.checked' | 'guard.failed',
  report: GuardReport,
): Promise<void> {
  try {
    await appendWorkItemEvent(getSql(), {
      workItemId,
      type,
      actor: 'guard',
      payload: { ...report },
    });
  } catch {
    // The audit row is advisory here; the guard verdict already governs the PR.
  }
}

/**
 * Creates the branch, applies the run's patch to the branch snapshot and commits the
 * resulting files, then opens a pull request referencing the work item (spec: forge
 * abstraction / branch and PR). Never touches the default branch.
 */
export async function forgeOpenPullRequest(
  args: OpenPullRequestArgs,
): Promise<OpenPullRequestResult> {
  const repo = factoryRepo(args.factoryRoot, args.factory);
  const forge = await resolveForge(args.factory);
  ensureSeeded(forge, repo);

  const branch = `factory/${args.workItemId}`;

  try {
    await forge.createBranch({ repo, name: branch });
    // The PR must contain the code, not the diff text: apply the captured patch to the
    // branch snapshot and commit the resulting files.
    const base = await forge.checkout({ repo, ref: branch });
    const patch = await readPatch(args.runId);
    const files = await applyPatch(base.files, patch).catch(asPatchFailure);

    // A rerun can capture a patch that is already on the base branch. The apply path then
    // returns no changes; commit a small audit marker so the PR still has a reviewable diff
    // and the factory loop can complete instead of failing on an empty commit.
    const commitFiles =
      files.length > 0
        ? files
        : [
            {
              path: `changes/${args.workItemId}.md`,
              content: `# ${args.workItemId}\n\nNo code changes: the captured patch was already applied to the base branch.\n`,
            },
          ];

    // Deterministic guard hooks (roadmap item 4): pure checks on the branch + applied files,
    // before anything is committed. A failure is fail-closed and non-retryable. Deleted
    // files are kept as empty entries so path containment and the file count still see them.
    const { definition } = loadDefinition(args.factoryRoot);
    const guardedFiles: Record<string, string> = Object.fromEntries(
      commitFiles.map((change) => [change.path, change.content ?? '']),
    );
    const report = runGuardHooks({
      branch,
      files: guardedFiles,
      ...(definition?.manifest.guard ? { config: definition.manifest.guard } : {}),
    });
    if (!report.passed) {
      await recordGuardEvent(args.workItemId, 'guard.failed', report);
      throw ApplicationFailure.create({
        type: 'guard_failed',
        nonRetryable: true,
        message: 'guard hooks rejected the pull request',
        details: [report],
      });
    }
    await recordGuardEvent(args.workItemId, 'guard.checked', report);

    const commit = await forge.commit({
      repo,
      branch,
      message: `factory: ${args.workItemId} — ${args.title}`,
      files: commitFiles,
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
  const forge = await resolveForge(args.factory);
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
  const forge = await resolveForge(args.factory);
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
  const forge = await resolveForge(args.factory);
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

/**
 * Reads the run's captured patch. A missing or empty diff is a hard failure: the forge
 * must never open a PR that pretends to contain a change it does not have.
 */
async function readPatch(runId: string): Promise<string> {
  const { runsDir } = loadConfig();
  let patch: string;
  try {
    patch = await readFile(join(runsDir, runId, 'patch.diff'), 'utf8');
  } catch {
    throw ApplicationFailure.create({
      type: 'patch_missing',
      nonRetryable: true,
      message: `run "${runId}" has no patch.diff`,
      details: [{ runId }],
    });
  }
  if (patch.trim().length === 0) {
    throw ApplicationFailure.create({
      type: 'patch_missing',
      nonRetryable: true,
      message: `run "${runId}" captured an empty patch.diff`,
      details: [{ runId }],
    });
  }
  return patch;
}
