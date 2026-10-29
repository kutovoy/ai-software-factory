import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  createCanaryRollout,
  getCanaryRollout,
  getInFlightCanaryRollout,
  getProposal,
  listCanaryRollouts,
  loadDefinition,
  recordCanaryEvent,
  serializeDefinition,
  updateCanaryRollout,
  updateProposal,
  type CanaryRolloutRecord,
  type ProposalRecord,
} from '@factory/core';
import { FakeForge, ForgeError, type FileChange, type RepoRef } from '@factory/forge';
import { getSql } from './db';
import { loadConfig } from './config';
import { getForge } from './activities/forge';
import { startCanaryWorkflow } from './canary-client';
import type { CanaryObservationSummary, CanaryWorkflowInput } from './types';

/**
 * Canary rollout mechanics (Phase 5b, ADR-021).
 *
 * Shared by the improvement workflow's decide activity, `POST /proposals/:id/apply` and the
 * canary routes so every path cannot drift:
 *  - `startCanaryRollout` creates the pending rollout row, marks the proposal `canary` and
 *    starts `CanaryWorkflow` (which publishes the candidate version).
 *  - `publishCanaryCandidate` materialises the candidate definition tree, commits it on a
 *    candidate branch and opens a PR; the rollout becomes `active` and starts routing.
 *  - `promoteCanaryRollout` merges the candidate PR into the base branch and ends the
 *    rollout `promoted` (the previous version stays recorded for rollback).
 *  - `rollbackCanaryRollout` ends it `rolled_back`; routing returns to stable immediately
 *    because the active-rollout query only sees `status = 'active'`.
 *
 * Every step is idempotent and guarded by the rollout status, so a Temporal retry or a
 * double-click cannot start, promote or roll back twice.
 */

export interface CanaryError extends Error {
  code: string;
  details?: unknown;
}

function codedError(code: string, message: string, details?: unknown): CanaryError {
  const error = new Error(message) as CanaryError;
  error.name = 'CanaryError';
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

function repoOf(key: string): RepoRef {
  const [owner, ...rest] = key.split('/');
  return { owner: owner as string, name: rest.join('/') };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function forgeFailure(error: unknown): never {
  if (error instanceof ForgeError) {
    throw codedError(error.code, error.message, error.details);
  }
  throw error;
}

function rolloutIdFor(factory: string, proposalId: string, candidateHash: string | null): string {
  return `canary_${createHash('sha256')
    .update(`${factory}\u0000${proposalId}\u0000${candidateHash ?? ''}`)
    .digest('hex')
    .slice(0, 24)}`;
}

/** Reads `factory-vN` tags (read-only git plumbing) to label the candidate version. */
function factoryVersionTags(dir: string): number[] {
  try {
    const output = execFileSync('git', ['tag', '--list', 'factory-v*'], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return output
      .split('\n')
      .map((line) => /^factory-v(\d+)$/.exec(line.trim())?.[1])
      .filter((value): value is string => Boolean(value))
      .map((value) => Number(value));
  } catch {
    return [];
  }
}

export interface CanaryVersionLabels {
  stableVersion: string;
  candidateVersion: string;
  /** Highest existing `factory-vN`, 0 when the definition repo has no version tag. */
  stableTagNumber: number;
}

/** `factory-vN+1-candidate` for the candidate; the current tag (or commit) for stable. */
export function canaryVersionLabels(dir: string, stableCommit: string): CanaryVersionLabels {
  const tags = factoryVersionTags(dir);
  const highest = tags.length > 0 ? Math.max(...tags) : 0;
  return {
    stableVersion: highest > 0 ? `factory-v${highest}` : `commit-${stableCommit.slice(0, 8)}`,
    candidateVersion: `factory-v${highest + 1}-candidate`,
    stableTagNumber: highest,
  };
}

/** Where the candidate definition tree is materialised (writable runs dir, ADR-012). */
export function canaryCandidateRoot(rolloutId: string): string {
  return join(loadConfig().runsDir, 'canary', rolloutId, 'definition');
}

function materializeCandidateTree(args: {
  factoryRoot: string;
  candidateRoot: string;
  diff: ProposalRecord['diff'];
  factory: string;
}): void {
  rmSync(args.candidateRoot, { recursive: true, force: true });
  mkdirSync(dirname(args.candidateRoot), { recursive: true });
  cpSync(args.factoryRoot, args.candidateRoot, { recursive: true });
  for (const entry of args.diff) {
    const absolute = join(args.candidateRoot, entry.path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, entry.after);
  }
  const { definition, errors } = loadDefinition(args.candidateRoot);
  if (!definition) {
    throw codedError(
      'candidate_invalid',
      `the composed candidate for "${args.factory}" does not validate`,
      { factory: args.factory, errors },
    );
  }
}

/* ------------------------------------------------------------------ start */

export interface StartCanaryRolloutArgs {
  factory: string;
  factoryRoot: string;
  definitionRepo: string;
  baseBranch?: string;
  proposal: ProposalRecord;
  /** Pinned commit of the definition tree the rollout starts from. */
  stableCommit: string;
  canaryPercent: number;
  rollbackThreshold: number;
  observationWindowHours: number;
  /** Test/short-window override; the workflow otherwise uses the hours value. */
  observationWindowMs?: number;
  checkIntervalMs?: number;
  actor: string;
  reason: string;
}

export interface StartedCanaryRollout {
  rollout: CanaryRolloutRecord;
  workflow: { workflowId: string; temporalRunId: string } | null;
  /** True when an existing rollout for the same candidate was returned (idempotent). */
  reused: boolean;
}

/**
 * Creates the rollout row and starts `CanaryWorkflow`. Publishing (candidate commit + PR)
 * happens inside the workflow, so the row is `pending` until the first activity activates
 * it; work items created meanwhile stay on stable.
 */
export async function startCanaryRollout(
  args: StartCanaryRolloutArgs,
): Promise<StartedCanaryRollout> {
  const sql = getSql();
  const proposal = await getProposal(sql, args.proposal.id);
  if (!proposal) throw codedError('proposal_not_found', `proposal "${args.proposal.id}" does not exist`);
  if (!proposal.candidateHash || proposal.diff.length === 0) {
    throw codedError('no_improvement', 'the proposal has no composed candidate', {
      proposalId: proposal.id,
    });
  }
  if (
    proposal.status !== 'accepted' &&
    proposal.status !== 'open' &&
    proposal.status !== 'canary' &&
    proposal.status !== 'canary_not_available'
  ) {
    throw codedError('proposal_not_accepted', `proposal "${proposal.id}" is ${proposal.status}`, {
      proposalId: proposal.id,
      status: proposal.status,
    });
  }

  const active = await getInFlightCanaryRollout(sql, args.factory);
  if (active && active.proposalId !== proposal.id) {
    throw codedError(
      'canary_active',
      `factory "${args.factory}" already has a canary rollout in flight`,
      { factory: args.factory, rolloutId: active.id },
    );
  }

  const labels = canaryVersionLabels(args.factoryRoot, args.stableCommit);
  const rolloutId = rolloutIdFor(args.factory, proposal.id, proposal.candidateHash);
  const existing = await getCanaryRollout(sql, rolloutId);
  if (existing) {
    return {
      rollout: existing,
      workflow: null,
      reused: true,
    };
  }

  const rollout = await createCanaryRollout(sql, {
    id: rolloutId,
    factory: args.factory,
    proposalId: proposal.id,
    candidateVersion: labels.candidateVersion,
    stableVersion: labels.stableVersion,
    stableCommit: args.stableCommit,
    canaryPercent: args.canaryPercent,
    rollbackThreshold: args.rollbackThreshold,
    observationWindowHours: args.observationWindowHours,
    status: 'pending',
    actor: args.actor,
    evidence: {
      proposalId: proposal.id,
      candidateHash: proposal.candidateHash,
      files: proposal.files,
      startedBy: args.actor,
      reason: args.reason,
    },
  });

  await updateProposal(sql, {
    id: proposal.id,
    status: 'canary',
    decisionActor: args.actor,
    decisionReason: `canary_rollout: ${args.reason}`,
    decided: true,
  });

  const input: CanaryWorkflowInput = {
    rolloutId,
    factory: args.factory,
    factoryRoot: args.factoryRoot,
    proposalId: proposal.id,
    definitionRepo: args.definitionRepo,
    ...(args.baseBranch ? { baseBranch: args.baseBranch } : {}),
    stableVersion: labels.stableVersion,
    stableCommit: args.stableCommit,
    candidateVersion: labels.candidateVersion,
    canaryPercent: args.canaryPercent,
    rollbackThreshold: args.rollbackThreshold,
    observationWindowHours: args.observationWindowHours,
    ...(args.observationWindowMs !== undefined ? { observationWindowMs: args.observationWindowMs } : {}),
    ...(args.checkIntervalMs !== undefined ? { checkIntervalMs: args.checkIntervalMs } : {}),
    actor: args.actor,
    reason: args.reason,
  };

  const workflow = await startCanaryWorkflow(input);
  return { rollout, workflow, reused: false };
}

/* ---------------------------------------------------------------- publish */

export interface PublishedCanaryCandidate {
  rollout: CanaryRolloutRecord;
  candidateCommit: string;
  prUrl: string;
  prNumber: number;
  candidateRoot: string;
}

/**
 * Publishes the candidate version: materialises the composed definition under the runs
 * dir, commits it on a `canary/<rolloutId>` branch of the definition repo and opens a PR
 * that promotion later merges. Then the rollout becomes `active` and routing starts.
 */
export async function publishCanaryCandidate(
  input: CanaryWorkflowInput,
): Promise<PublishedCanaryCandidate> {
  const sql = getSql();
  const rollout = await getCanaryRollout(sql, input.rolloutId);
  if (!rollout) {
    throw codedError('canary_not_found', `rollout "${input.rolloutId}" does not exist`, {
      rolloutId: input.rolloutId,
    });
  }
  if (rollout.status !== 'pending') {
    return {
      rollout,
      candidateCommit: rollout.candidateCommit ?? '',
      prUrl: rollout.prUrl ?? '',
      prNumber: rollout.prNumber ?? 0,
      candidateRoot: rollout.candidateRoot ?? '',
    };
  }

  const proposal = await getProposal(sql, rollout.proposalId);
  if (!proposal) {
    throw codedError('proposal_not_found', `proposal "${rollout.proposalId}" does not exist`);
  }

  const candidateRoot = canaryCandidateRoot(rollout.id);
  try {
    materializeCandidateTree({
      factoryRoot: input.factoryRoot,
      candidateRoot,
      diff: proposal.diff,
      factory: input.factory,
    });
  } catch (error) {
    await updateCanaryRollout(sql, {
      id: rollout.id,
      from: 'pending',
      status: 'unavailable',
      reason: `candidate_invalid: ${message(error)}`,
      ended: true,
    });
    throw error;
  }

  const { definition } = loadDefinition(input.factoryRoot);
  if (!definition) {
    throw codedError('definition_invalid', `factory "${input.factory}" does not validate`);
  }

  const repo = repoOf(input.definitionRepo);
  const forge = getForge();
  const baselineFiles = Object.fromEntries(
    serializeDefinition(definition).map((file) => [file.path, file.content]),
  );
  if (forge instanceof FakeForge) forge.seedRepo(repo, baselineFiles);

  const branch = `canary/${rollout.id}`;
  try {
    await forge.createBranch({
      repo,
      name: branch,
      ...(input.baseBranch ? { from: input.baseBranch } : {}),
    });
    const files: FileChange[] = proposal.diff.map((entry) => ({
      path: entry.path,
      content: entry.after,
    }));
    const commit = await forge.commit({
      repo,
      branch,
      message: `factory: canary candidate ${input.candidateVersion} (${proposal.failureSignature})`,
      files,
    });
    const pull = await forge.openPullRequest({
      repo,
      head: branch,
      ...(input.baseBranch ? { base: input.baseBranch } : {}),
      title: `Canary candidate: ${proposal.title}`,
      body: [
        `# ${proposal.title}`,
        '',
        proposal.summary,
        '',
        `- Candidate version: \`${input.candidateVersion}\``,
        `- Stable version: \`${input.stableVersion}\``,
        `- Candidate hash: \`${proposal.candidateHash}\``,
        `- Traffic: ${input.canaryPercent}% of new work items (deterministic hash of the item id)`,
        `- Observation window: ${input.observationWindowHours}h`,
        `- Rollback threshold: ${input.rollbackThreshold}`,
        `- Started by: ${input.actor}${input.reason ? ` — ${input.reason}` : ''}`,
        '',
        'Merging this pull request is the promotion step; rolling back leaves it open.',
      ].join('\n'),
      draft: true,
    });

    const updated = await updateCanaryRollout(sql, {
      id: rollout.id,
      from: 'pending',
      status: 'active',
      candidateCommit: commit.sha,
      candidateRoot,
      prUrl: pull.url,
      prNumber: pull.number,
      reason: null,
    });
    if (!updated) {
      const current = await getCanaryRollout(sql, rollout.id);
      if (!current) throw codedError('canary_not_found', `rollout "${rollout.id}" disappeared`);
      return {
        rollout: current,
        candidateCommit: current.candidateCommit ?? '',
        prUrl: current.prUrl ?? '',
        prNumber: current.prNumber ?? 0,
        candidateRoot: current.candidateRoot ?? '',
      };
    }

    await recordCanaryEvent(sql, {
      rolloutId: rollout.id,
      factory: input.factory,
      type: 'canary.started',
      payload: {
        rolloutId: rollout.id,
        factory: input.factory,
        proposalId: proposal.id,
        candidateVersion: input.candidateVersion,
        stableVersion: input.stableVersion,
        candidateCommit: commit.sha,
        stableCommit: input.stableCommit,
        canaryPercent: input.canaryPercent,
        rollbackThreshold: input.rollbackThreshold,
        observationWindowHours: input.observationWindowHours,
        candidateHash: proposal.candidateHash,
        files: proposal.files,
        prUrl: pull.url,
        prNumber: pull.number,
        actor: input.actor,
        reason: input.reason ?? null,
      },
    });

    return {
      rollout: updated,
      candidateCommit: commit.sha,
      prUrl: pull.url,
      prNumber: pull.number,
      candidateRoot,
    };
  } catch (error) {
    await updateCanaryRollout(sql, {
      id: rollout.id,
      from: 'pending',
      status: 'unavailable',
      reason: `publish_failed: ${message(error)}`,
      ended: true,
    });
    forgeFailure(error);
  }
}

/* ---------------------------------------------------------------- promote */

export interface CanaryFinishArgs {
  rolloutId: string;
  factory: string;
  actor: string;
  reason: string;
  observation?: CanaryObservationSummary | null;
  automatic?: boolean;
}

export interface CanaryFinishResult {
  rollout: CanaryRolloutRecord;
  /** False when the rollout was already terminal (a retry or a manual action won). */
  changed: boolean;
  mergedCommit?: string | null;
}

/**
 * Promotes the candidate: merges the candidate PR into the base branch, ends the rollout
 * `promoted` and marks the proposal `merged`. Refuses (leaves the rollout active) when the
 * forge merge fails, so a red candidate can never become stable by accident.
 */
export async function promoteCanaryRollout(
  args: CanaryFinishArgs,
): Promise<CanaryFinishResult> {
  const sql = getSql();
  const rollout = await getCanaryRollout(sql, args.rolloutId);
  if (!rollout) {
    throw codedError('canary_not_found', `rollout "${args.rolloutId}" does not exist`, {
      rolloutId: args.rolloutId,
    });
  }
  if (rollout.status !== 'active') {
    return { rollout, changed: false };
  }
  if (!rollout.prNumber) {
    throw codedError('canary_not_published', 'the candidate has no pull request to merge', {
      rolloutId: rollout.id,
    });
  }

  const repoRef: RepoRef = { owner: loadConfig().definitionRepoOwner, name: rollout.factory };

  const forge = getForge();
  let mergedCommit: string | null = null;
  try {
    const merged = await forge.merge({ repo: repoRef, pullRequestNumber: rollout.prNumber });
    mergedCommit = merged.sha;
  } catch (error) {
    forgeFailure(error);
  }

  const evidence = {
    ...rollout.evidence,
    ...(args.observation ? { observation: args.observation.evidence } : {}),
    promotion: { actor: args.actor, reason: args.reason, mergedCommit, at: new Date().toISOString() },
  };
  const updated = await updateCanaryRollout(sql, {
    id: rollout.id,
    from: 'active',
    status: 'promoted',
    reason: args.reason,
    evidence,
    ended: true,
  });
  if (!updated) {
    const current = await getCanaryRollout(sql, rollout.id);
    return { rollout: (current ?? rollout) as CanaryRolloutRecord, changed: false, mergedCommit };
  }

  await updateProposal(sql, {
    id: rollout.proposalId,
    status: 'merged',
    decisionActor: args.actor,
    decisionReason: `canary_promoted: ${args.reason}`,
    decided: true,
  });

  await recordCanaryEvent(sql, {
    rolloutId: rollout.id,
    factory: rollout.factory,
    type: 'canary.promoted',
    payload: {
      rolloutId: rollout.id,
      factory: rollout.factory,
      proposalId: rollout.proposalId,
      candidateVersion: rollout.candidateVersion,
      stableVersion: rollout.stableVersion,
      candidateCommit: rollout.candidateCommit,
      mergedCommit,
      canaryPercent: rollout.canaryPercent,
      observationWindowHours: rollout.observationWindowHours,
      actor: args.actor,
      reason: args.reason,
      automatic: args.automatic ?? false,
      evidence: args.observation?.evidence ?? {},
      prUrl: rollout.prUrl,
      prNumber: rollout.prNumber,
    },
  });

  return { rollout: updated, changed: true, mergedCommit };
}

/* --------------------------------------------------------------- rollback */

/**
 * Rolls back: routing returns to stable immediately (the active-rollout query stops
 * matching), the proposal is marked `rolled_back`, and `canary.rolled_back` records the
 * reason and the evidence. Works for `pending` (a rollout that never activated) and
 * `active` rollouts, and is idempotent for an already-terminal one.
 */
export async function rollbackCanaryRollout(
  args: CanaryFinishArgs,
): Promise<CanaryFinishResult> {
  const sql = getSql();
  const rollout = await getCanaryRollout(sql, args.rolloutId);
  if (!rollout) {
    throw codedError('canary_not_found', `rollout "${args.rolloutId}" does not exist`, {
      rolloutId: args.rolloutId,
    });
  }
  if (rollout.status !== 'active' && rollout.status !== 'pending') {
    return { rollout, changed: false };
  }

  const evidence = {
    ...rollout.evidence,
    ...(args.observation ? { observation: args.observation.evidence } : {}),
    rollback: {
      actor: args.actor,
      reason: args.reason,
      automatic: args.automatic ?? false,
      at: new Date().toISOString(),
    },
  };
  const updated = await updateCanaryRollout(sql, {
    id: rollout.id,
    from: ['active', 'pending'],
    status: 'rolled_back',
    reason: args.reason,
    evidence,
    ended: true,
  });
  if (!updated) {
    const current = await getCanaryRollout(sql, rollout.id);
    return { rollout: (current ?? rollout) as CanaryRolloutRecord, changed: false };
  }

  await updateProposal(sql, {
    id: rollout.proposalId,
    status: 'rolled_back',
    decisionActor: args.actor,
    decisionReason: `canary_rolled_back: ${args.reason}`,
    decided: true,
  });

  await recordCanaryEvent(sql, {
    rolloutId: rollout.id,
    factory: rollout.factory,
    type: 'canary.rolled_back',
    payload: {
      rolloutId: rollout.id,
      factory: rollout.factory,
      proposalId: rollout.proposalId,
      candidateVersion: rollout.candidateVersion,
      stableVersion: rollout.stableVersion,
      candidateCommit: rollout.candidateCommit,
      canaryPercent: rollout.canaryPercent,
      rollbackThreshold: rollout.rollbackThreshold,
      observationWindowHours: rollout.observationWindowHours,
      actor: args.actor,
      reason: args.reason,
      automatic: args.automatic ?? false,
      evidence: args.observation?.evidence ?? {},
      prUrl: rollout.prUrl,
      prNumber: rollout.prNumber,
    },
  });

  // Best effort: leave an audit trail on the candidate PR. A forge failure must not undo
  // the rollback — routing already returned to stable.
  if (rollout.prNumber) {
    try {
      const repo: RepoRef = {
        owner: loadConfig().definitionRepoOwner,
        name: rollout.factory,
      };
      await getForge().comment({
        repo,
        pullRequestNumber: rollout.prNumber,
        body: `Canary rolled back by ${args.actor}: ${args.reason}`,
        author: args.actor,
      });
    } catch {
      // ignore: the rollout row and the event are the source of truth
    }
  }

  return { rollout: updated, changed: true };
}

/* ------------------------------------------------------------- resolution */

export interface ResolvedCanaryTarget {
  rollout: CanaryRolloutRecord;
}

/**
 * Finds the rollout a manual action targets: by id, by proposal, else the factory's newest
 * rollout in `pending`/`active`. Returns null when there is nothing to act on.
 */
export async function resolveCanaryRollout(args: {
  factory: string;
  rolloutId?: string | null;
  proposalId?: string | null;
}): Promise<CanaryRolloutRecord | null> {
  const sql = getSql();
  if (args.rolloutId) {
    const rollout = await getCanaryRollout(sql, args.rolloutId);
    return rollout && rollout.factory === args.factory ? rollout : null;
  }
  const history = await listCanaryRollouts(sql, { factory: args.factory, limit: 20 });
  if (args.proposalId) {
    // Target one proposal explicitly: never act on another proposal's rollout.
    return (
      history.find(
        (rollout) =>
          rollout.proposalId === args.proposalId &&
          (rollout.status === 'active' || rollout.status === 'pending'),
      ) ?? null
    );
  }
  return (
    history.find((rollout) => rollout.status === 'active') ??
    history.find((rollout) => rollout.status === 'pending') ??
    null
  );
}

/** True when the candidate tree still exists (a missing tree means a broken rollout). */
export function candidateTreeExists(rollout: CanaryRolloutRecord): boolean {
  return Boolean(rollout.candidateRoot && existsSync(rollout.candidateRoot));
}
