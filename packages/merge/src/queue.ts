import type { CheckRun, ChecksResult, CodeForge, MergeResult, RepoRef } from '@factory/forge';

/**
 * Merge queue engine (spec `merge-queue`).
 *
 * A factory has at most one batch in flight. The engine takes the batch the scheduler
 * selected, merges every pull request in it, then **gates the merged stack**: only a green
 * stack counts as merged. A red stack is bisected (the batch is reverted as one commit, then
 * items are re-merged one at a time; the offender is marked `needs_human` with the failing
 * checks as evidence) and a stack that never reports within the timeout fails
 * `checks_timeout` with nothing merged.
 *
 * The engine is deterministic and transport-agnostic: the forge is injected, sleeps and
 * clocks are injected, so the same code runs in a Temporal activity and in unit tests.
 */

export type MergeQueueItemStatus =
  | 'queued'
  | 'batched'
  | 'merged'
  | 'reverted'
  | 'needs_human'
  | 'failed';

export interface MergeQueueItem {
  /** Stable queue id (`mb_<ulid>`), shared with `merge_batch_items.id`. */
  id: string;
  pullRequestNumber: number;
  workItemId?: string | null;
  head: string;
  status: MergeQueueItemStatus;
  commitSha?: string | null;
  evidence?: Record<string, unknown>;
}

export interface MergeQueueBatch {
  id: string;
  factory: string;
  repo: RepoRef;
  items: MergeQueueItem[];
  /** Default-branch head before the batch; a revert restores exactly this tree. */
  baseSha: string;
  /** Default-branch head after the batch merged (or after a revert). */
  mergeSha: string | null;
  status:
    | 'queued'
    | 'merging'
    | 'verifying'
    | 'merged'
    | 'bisected'
    | 'reverted'
    | 'checks_timeout'
    | 'failed';
  checks: CheckRun[];
  evidence: Record<string, unknown>;
  actor?: string | null;
  reason?: string | null;
}

export type MergeQueueEventType =
  | 'merge.batch.started'
  | 'merge.batch.merged'
  | 'merge.batch.red'
  | 'merge.bisected'
  | 'merge.item.merged'
  | 'merge.item.needs_human'
  | 'merge.item.failed'
  | 'merge.checks_timeout'
  | 'merge.reverted';

export interface MergeQueueEvent {
  type: MergeQueueEventType;
  batchId: string;
  factory: string;
  /** Dedupe subject (item id / reason) — the repository dedupes on `(batch, type, subject)`. */
  subject?: string;
  payload?: Record<string, unknown>;
}

export interface MergeQueueHooks {
  /** Persists an item transition (idempotent). */
  onItem?: (item: MergeQueueItem) => void | Promise<void>;
  /** Persists a batch transition (idempotent). */
  onBatch?: (batch: MergeQueueBatch) => void | Promise<void>;
  /** Records an append-only event (deduped by batch + type + subject). */
  onEvent?: (event: MergeQueueEvent) => void | Promise<void>;
}

export interface MergeQueueOptions {
  forge: CodeForge;
  repo: RepoRef;
  /** Default batch size (spec: configurable, default 2). */
  batchSize?: number;
  /** Required check names; empty means "every reported check". */
  requiredChecks?: string[];
  /** How long the merged stack may stay pending before `checks_timeout`. */
  checksTimeoutMs?: number;
  pollIntervalMs?: number;
  /** Injected so tests do not wait for real. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /**
   * Stack gate. Defaults to the forge's checks for the default branch. Tests inject a
   * predicate that models a semantic conflict (all PRs green individually, stack red).
   */
  checkStack?: (input: {
    forge: CodeForge;
    repo: RepoRef;
    ref: string;
    batch: MergeQueueBatch;
    merged: MergeQueueItem[];
  }) => Promise<ChecksResult>;
  hooks?: MergeQueueHooks;
}

export interface RunMergeBatchResult {
  batch: MergeQueueBatch;
  merged: MergeQueueItem[];
  needsHuman: MergeQueueItem[];
  reverted: boolean;
  reason?: string;
}

const DEFAULT_BATCH_SIZE = 2;
const DEFAULT_CHECKS_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 2_000;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Deterministic batch selection: the oldest `batchSize` queued items. */
export function selectBatch<T>(queue: T[], batchSize: number = DEFAULT_BATCH_SIZE): T[] {
  const size = Math.min(Math.max(batchSize, 1), 20);
  return queue.slice(0, size);
}

function failing(checks: CheckRun[], required: string[]): CheckRun[] {
  return checks.filter((check) => {
    if (required.length > 0 && !required.includes(check.name)) return false;
    // `pending` is not a failure: it is handled by the timeout budget.
    return check.conclusion !== 'success' && check.conclusion !== 'skipped' && check.conclusion !== 'pending';
  });
}

function pending(checks: CheckRun[], required: string[]): CheckRun[] {
  return checks.filter((check) => {
    if (required.length > 0 && !required.includes(check.name)) return false;
    return check.conclusion === 'pending';
  });
}

/**
 * Runs one batch as a **merge train**: each pull request is merged, then the merged stack is
 * gated at the new head. A green stack keeps the merge; a red stack reverts just that merge
 * (one revert commit) and marks the pull request `needs_human` with the failing checks —
 * the rest of the batch still merges, so the clean subset lands. A stack that never reports
 * within the timeout reverts the whole batch and fails `checks_timeout` with nothing merged.
 *
 * Merging incrementally is deliberate: a merged pull request cannot be merged twice (GitHub
 * and the fake forge both refuse), so bisecting by reverting the batch and re-merging is not
 * possible through the `CodeForge` contract. The train reaches the same outcome — the
 * offending PR is isolated and the clean subset merges — without re-merging.
 *
 * Idempotency: items already `merged` (a retried activity) are skipped, so a Temporal retry
 * never merges a pull request twice.
 */
export async function runMergeBatch(
  batch: MergeQueueBatch,
  options: MergeQueueOptions,
): Promise<RunMergeBatchResult> {
  const forge = options.forge;
  const repo = options.repo;
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const required = options.requiredChecks ?? [];
  const timeoutMs = options.checksTimeoutMs ?? DEFAULT_CHECKS_TIMEOUT_MS;
  const pollMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? (() => Date.now());
  const hooks = options.hooks ?? {};

  const emit = async (event: MergeQueueEvent): Promise<void> => {
    await hooks.onEvent?.(event);
  };
  const saveItem = async (item: MergeQueueItem): Promise<void> => {
    await hooks.onItem?.(item);
  };
  const saveBatch = async (next: MergeQueueBatch): Promise<void> => {
    await hooks.onBatch?.(next);
  };

  const stackGate =
    options.checkStack ??
    (async ({ forge: backend, repo: target, ref }): Promise<ChecksResult> =>
      backend.getChecks({ repo: target, ref }));

  const items = selectBatch(batch.items, batchSize);
  batch.items = items;

  const base = await forge.checkout({ repo });
  batch.baseSha = base.commit;
  batch.status = 'merging';
  await saveBatch(batch);
  await emit({
    type: 'merge.batch.started',
    batchId: batch.id,
    factory: batch.factory,
    payload: { baseSha: base.commit, prs: items.map((item) => item.pullRequestNumber) },
  });

  const merged: MergeQueueItem[] = [];
  const needsHuman: MergeQueueItem[] = [];
  /** Head that a revert restores: the last green merged stack. */
  let goodSha = base.commit;

  for (const item of items) {
    if (item.status === 'merged') {
      merged.push(item);
      goodSha = item.commitSha ?? goodSha;
      continue;
    }

    try {
      const result: MergeResult = await forge.merge({
        repo,
        pullRequestNumber: item.pullRequestNumber,
        method: 'squash',
      });
      item.commitSha = result.sha ?? null;
    } catch (error) {
      // A PR that cannot merge on its own (red checks, conflict) never enters the stack.
      const code = errorCode(error);
      item.status = code === 'checks_not_green' ? 'needs_human' : 'failed';
      item.commitSha = null;
      item.evidence = { reason: code, message: messageOf(error) };
      if (item.status === 'needs_human') needsHuman.push(item);
      await saveItem(item);
      await emit({
        type: item.status === 'needs_human' ? 'merge.item.needs_human' : 'merge.item.failed',
        batchId: batch.id,
        factory: batch.factory,
        subject: item.id,
        payload: { pr: item.pullRequestNumber, reason: code },
      });
      continue;
    }

    // Gate the merged stack at the new head before keeping the merge.
    batch.status = 'verifying';
    await saveBatch(batch);

    const gate = await waitForStack({
      forge,
      repo,
      batch,
      merged: [...merged, item],
      stackGate,
      required,
      timeoutMs,
      pollMs,
      sleep,
      now,
      ...(item.commitSha ? { ref: item.commitSha } : {}),
    });

    if (gate.state === 'green') {
      batch.checks = gate.checks;
      item.status = 'merged';
      merged.push(item);
      goodSha = item.commitSha ?? goodSha;
      await saveItem(item);
      await emit({
        type: 'merge.item.merged',
        batchId: batch.id,
        factory: batch.factory,
        subject: item.id,
        payload: { pr: item.pullRequestNumber, sha: item.commitSha },
      });
      continue;
    }

    if (gate.state === 'timeout') {
      batch.status = 'checks_timeout';
      batch.reason = `required checks did not complete within ${timeoutMs}ms`;
      batch.checks = gate.checks;
      await emit({
        type: 'merge.checks_timeout',
        batchId: batch.id,
        factory: batch.factory,
        payload: { checks: gate.checks, timeoutMs, prs: items.map((entry) => entry.pullRequestNumber) },
      });

      // Nothing merges: restore the pre-batch tree as one revert commit.
      const revertSha = await revertTo(
        forge,
        repo,
        batch.baseSha,
        `Revert batch ${batch.id}: checks timeout`,
      );
      batch.mergeSha = revertSha;
      batch.status = 'reverted';
      await saveBatch(batch);
      await emit({
        type: 'merge.reverted',
        batchId: batch.id,
        factory: batch.factory,
        payload: {
          reason: 'checks_timeout',
          revertSha,
          prs: [...merged, item].map((entry) => entry.pullRequestNumber),
        },
      });

      for (const entry of [...merged, item]) {
        entry.status = 'reverted';
        entry.commitSha = null;
        await saveItem(entry);
      }
      return { batch, merged: [], needsHuman, reverted: true, reason: 'checks_timeout' };
    }

    // Red stack: revert just this merge (one commit) and hand the PR to a human.
    const revertSha = await revertTo(
      forge,
      repo,
      goodSha,
      `Revert pull request #${item.pullRequestNumber}: merged stack is red`,
    );
    batch.checks = gate.checks;
    item.status = 'needs_human';
    item.commitSha = null;
    item.evidence = {
      reason: 'red_stack',
      checks: gate.checks,
      failing: failing(gate.checks, required).map((check) => check.name),
      revertSha,
    };
    needsHuman.push(item);
    await saveItem(item);
    await emit({
      type: 'merge.batch.red',
      batchId: batch.id,
      factory: batch.factory,
      payload: {
        pr: item.pullRequestNumber,
        checks: gate.checks,
        revertSha,
        kept: merged.map((entry) => entry.pullRequestNumber),
      },
    });
    await emit({
      type: 'merge.reverted',
      batchId: batch.id,
      factory: batch.factory,
      subject: item.id,
      payload: {
        reason: 'red_stack',
        revertSha,
        failing: failing(gate.checks, required).map((check) => check.name),
        prs: [item.pullRequestNumber],
      },
    });
    await emit({
      type: 'merge.item.needs_human',
      batchId: batch.id,
      factory: batch.factory,
      subject: item.id,
      payload: item.evidence,
    });
  }

  if (merged.length === 0 && needsHuman.length === 0) {
    batch.status = 'failed';
    batch.reason = 'no pull request in the batch could be merged';
    await saveBatch(batch);
    return { batch, merged, needsHuman, reverted: false, reason: batch.reason };
  }

  batch.status = needsHuman.length > 0 ? 'bisected' : 'merged';
  batch.mergeSha = goodSha;
  batch.evidence = {
    ...batch.evidence,
    ...(needsHuman.length > 0
      ? {
          bisected: true,
          mergedPrs: merged.map((entry) => entry.pullRequestNumber),
          offenders: needsHuman.map((entry) => entry.pullRequestNumber),
        }
      : {}),
  };
  await saveBatch(batch);

  if (needsHuman.length > 0) {
    await emit({
      type: 'merge.bisected',
      batchId: batch.id,
      factory: batch.factory,
      payload: batch.evidence,
    });
  } else {
    await emit({
      type: 'merge.batch.merged',
      batchId: batch.id,
      factory: batch.factory,
      payload: { mergeSha: goodSha, prs: merged.map((entry) => entry.pullRequestNumber) },
    });
  }

  return {
    batch,
    merged,
    needsHuman,
    reverted: needsHuman.length > 0,
    ...(needsHuman.length > 0 ? { reason: 'red_stack' } : {}),
  };
}

/**
 * Manual revert (spec: a human triggers a revert → the batch is reverted regardless of
 * checks, and the action is audited). Returns the revert commit.
 */
export async function revertMergeBatch(
  batch: MergeQueueBatch,
  options: MergeQueueOptions,
  args: { actor: string; reason: string; toSha?: string },
): Promise<{ sha: string; batch: MergeQueueBatch }> {
  const forge = options.forge;
  const repo = options.repo;
  const target = args.toSha ?? batch.baseSha;
  const sha = await revertTo(forge, repo, target, `Revert batch ${batch.id}: ${args.reason}`);

  batch.status = 'reverted';
  batch.mergeSha = sha;
  batch.actor = args.actor;
  batch.reason = args.reason;
  batch.evidence = {
    ...batch.evidence,
    revert: { sha, toSha: target, actor: args.actor, reason: args.reason, automatic: false },
  };
  await options.hooks?.onBatch?.(batch);
  await options.hooks?.onEvent?.({
    type: 'merge.reverted',
    batchId: batch.id,
    factory: batch.factory,
    payload: { reason: args.reason, actor: args.actor, revertSha: sha, automatic: false },
  });
  for (const item of batch.items) {
    if (item.status === 'merged') {
      item.status = 'reverted';
      await options.hooks?.onItem?.(item);
    }
  }
  return { sha, batch };
}

/* -------------------------------------------------------------- internals */

interface StackGateResult {
  state: 'green' | 'red' | 'timeout';
  checks: CheckRun[];
  ref: string;
}

async function waitForStack(input: {
  forge: CodeForge;
  repo: RepoRef;
  batch: MergeQueueBatch;
  merged: MergeQueueItem[];
  stackGate: NonNullable<MergeQueueOptions['checkStack']>;
  required: string[];
  timeoutMs: number;
  pollMs: number;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /** Gate a specific merged-stack head (bisect prefix); defaults to the current head. */
  ref?: string;
}): Promise<StackGateResult> {
  const deadline = input.now() + input.timeoutMs;

  for (;;) {
    const ref = input.ref ?? (await input.forge.checkout({ repo: input.repo })).commit;
    const result = await input.stackGate({
      forge: input.forge,
      repo: input.repo,
      ref,
      batch: input.batch,
      merged: input.merged,
    });

    const red = failing(result.checks, input.required);
    if (red.length === 0 && (result.green || pending(result.checks, input.required).length === 0)) {
      return { state: 'green', checks: result.checks, ref };
    }
    if (red.length > 0) return { state: 'red', checks: result.checks, ref };

    if (input.now() >= deadline) {
      return { state: 'timeout', checks: result.checks, ref };
    }
    await input.sleep(input.pollMs);
  }
}

async function revertTo(
  forge: CodeForge,
  repo: RepoRef,
  toSha: string,
  message: string,
): Promise<string> {
  if (!forge.revert) {
    throw new Error('the forge backend cannot revert the default branch');
  }
  const result = await forge.revert({ repo, toSha, message });
  return result.sha;
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : 'error';
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
