import { createHash } from 'node:crypto';
import { ForgeError } from './errors';
import {
  repoKey,
  type BranchRef,
  type CheckRun,
  type ChecksResult,
  type CodeForge,
  type Comment,
  type CommentInput,
  type CommitInput,
  type CommitRef,
  type CreateBranchInput,
  type CheckoutInput,
  type CheckoutResult,
  type FileChange,
  type GetChecksInput,
  type MergeInput,
  type MergeResult,
  type OpenPullRequestInput,
  type PullRequest,
  type RepoRef,
  type RevertInput,
  type RevertResult,
} from './types';

/**
 * GitHub `CodeForge` backend (spec `code-forge` › GitHub backend, design decision 1/2/3).
 *
 * - **Credential by reference.** The token is resolved at call time from a secret *name*
 *   (`GITHUB_TOKEN` by default) — never stored on the instance, never in an event or log.
 * - **Transport is injected.** `fetch` is a constructor argument, so CI replays recorded
 *   responses (no network) while production passes the platform `fetch`. A real network
 *   call is only made when the caller opts in (`RUN_GITHUB=1` in the test harness).
 * - **ETag cache + backoff.** GETs are cached by ETag; 5xx/network errors back off
 *   exponentially; a rate-limit response retries within a budget and then surfaces
 *   `rate_limited` with the reset time.
 * - **Dry run.** `GITHUB_DRY_RUN=1` (or `dryRun: true`) makes every mutating call a no-op
 *   that returns a synthetic result and emits `github.intended_action`; the repository is
 *   untouched and no request leaves the process.
 * - **Protected branch.** A commit (or branch creation) aimed at the default branch is
 *   rejected locally with `protected_branch`; merges and reverts are the only writes there.
 */

/** The minimum response surface the client needs; the platform `fetch` satisfies it. */
export interface GithubResponseLike {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}

export type GithubFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<GithubResponseLike>;

export type GithubActionName =
  | 'checkout'
  | 'branch.create'
  | 'commit'
  | 'pull.open'
  | 'comment'
  | 'merge'
  | 'revert';

/** API dialect: GitHub's REST surface, or the Gitea/Forgejo-compatible one. */
export type GithubApiFlavor = 'github' | 'gitea';

/** Emitted for every intended mutation in dry-run mode (and for every write in real mode). */
export interface GithubIntendedAction {
  type: 'github.intended_action';
  action: GithubActionName;
  repo: string;
  at: number;
  detail: Record<string, unknown>;
}

export interface GithubForgeOptions {
  /** Injected transport; defaults to the platform `fetch` (never used in CI). */
  fetch?: GithubFetch;
  /** Secret *name* holding the token. The value is resolved per call. */
  secretRef?: string;
  /** Pre-resolved token (tests only). Never logged. */
  token?: string;
  /** Resolves a secret name to its value; defaults to the process environment. */
  resolveSecret?: (ref: string) => string | undefined;
  /** API root, defaults to `https://api.github.com`. */
  baseUrl?: string;
  /**
   * API dialect. GitHub and Gitea/Forgejo share the PR/issue surface but differ on git
   * refs, commits, checks and merge; the client adapts behind the same `CodeForge`
   * contract (spec `code-forge` › API compatibility). Auto-detected from `baseUrl`:
   * anything other than `api.github.com` is treated as Gitea-compatible.
   */
  flavor?: GithubApiFlavor;
  /** `GITHUB_DRY_RUN=1` equivalent. */
  dryRun?: boolean;
  /** Injected sleep so a rate-limit/backoff test does not wait for real. */
  sleep?: (ms: number) => Promise<void>;
  /** Retry budget for 5xx/network errors. */
  maxRetries?: number;
  /** Retry budget for rate-limit responses. */
  maxRateLimitRetries?: number;
  /** Hard cap on a rate-limit wait (ms); beyond it the call fails `rate_limited`. */
  maxBackoffMs?: number;
  now?: () => number;
  /** Intended-action sink (dry-run events). */
  onAction?: (action: GithubIntendedAction) => void;
  /** Author recorded on commits when the caller does not provide one. */
  author?: { name: string; email: string };
}

const DEFAULT_AUTHOR = { name: 'factory-agent', email: 'agent@factory.local' };
const DEFAULT_BASE = 'https://api.github.com';
const WORK_ITEM_MARKER = /<!--\s*factory-work-item:\s*([^\s>]+)\s*-->/;

interface GithubRepoInfo {
  defaultBranch: string;
}

interface GithubPullResponse {
  number: number;
  html_url: string;
  state: string;
  title: string;
  body: string | null;
  head: { ref: string; sha: string };
  base: { ref: string };
  created_at: string;
  merged: boolean;
  merged_at: string | null;
  /** Gitea/Forgejo only: the commit created by the merge on the base branch. */
  merge_commit_sha?: string | null;
}

interface GiteaRefResponse {
  ref: string;
  object: { sha: string };
}

interface GiteaStatusResponse {
  state: string;
  statuses: { status: string; context?: string; description?: string; target_url?: string }[] | null;
}

interface GiteaContentResponse {
  sha: string;
  content?: string;
  encoding?: string;
}

interface GiteaWriteResponse {
  commit: { sha: string };
}

interface GithubTreeResponse {
  sha: string;
  truncated?: boolean;
  tree: { path: string; type: string; mode: string; sha: string }[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function envSecret(ref: string): string | undefined {
  return process.env[ref] ?? process.env[ref.toUpperCase()] ?? process.env[`SECRET_${ref.toUpperCase()}`];
}

/**
 * `api.github.com` is the only host whose REST surface is GitHub's own; every other base
 * URL (a local Forgejo/Gitea, an enterprise GitHub host is an exception but opts in with
 * `flavor: 'github'`) is served by the Gitea-compatible dialect.
 */
function detectFlavor(baseUrl: string): GithubApiFlavor {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host === 'api.github.com' || host.endsWith('.api.github.com') ? 'github' : 'gitea';
  } catch {
    return 'github';
  }
}

/** Gitea commit status → the contract's `CheckConclusion`. */
function giteaConclusion(status: string): CheckRun['conclusion'] {
  switch (status) {
    case 'success':
      return 'success';
    case 'failure':
    case 'error':
      return 'failure';
    case 'pending':
      return 'pending';
    case 'skipped':
      return 'skipped';
    default:
      return 'neutral';
  }
}

/** Gitea merge styles are spelled in `Do`; the contract keeps GitHub's `merge_method` names. */
function giteaMergeStyle(method: MergeInput['method']): string {
  return method === 'squash' ? 'squash' : method === 'rebase' ? 'rebase' : 'merge';
}

export class GitHubForge implements CodeForge {
  readonly id = 'github' as const;

  private readonly fetchImpl: GithubFetch;
  private readonly secretRef: string;
  private readonly resolveSecret: (ref: string) => string | undefined;
  private readonly baseUrl: string;
  private readonly flavor: GithubApiFlavor;
  private readonly dryRun: boolean;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRetries: number;
  private readonly maxRateLimitRetries: number;
  private readonly maxBackoffMs: number;
  private readonly now: () => number;
  private readonly onAction?: (action: GithubIntendedAction) => void;
  private readonly author: { name: string; email: string };

  private readonly etags = new Map<string, { etag: string; body: unknown }>();
  private readonly repos = new Map<string, GithubRepoInfo>();
  private readonly intended: GithubIntendedAction[] = [];
  /** Set once a call has resolved a token; only kept in memory, never serialised. */
  private token: string | null;

  constructor(options: GithubForgeOptions = {}) {
    this.fetchImpl = options.fetch ?? (globalThis.fetch as unknown as GithubFetch);
    if (!this.fetchImpl) {
      throw new Error('GitHubForge needs a fetch implementation (inject one for tests)');
    }
    this.secretRef = options.secretRef ?? 'GITHUB_TOKEN';
    this.resolveSecret = options.resolveSecret ?? envSecret;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, '');
    this.flavor = options.flavor ?? detectFlavor(this.baseUrl);
    this.dryRun = options.dryRun ?? process.env.GITHUB_DRY_RUN === '1';
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.maxRetries = options.maxRetries ?? 3;
    this.maxRateLimitRetries = options.maxRateLimitRetries ?? 2;
    this.maxBackoffMs = options.maxBackoffMs ?? 60_000;
    this.now = options.now ?? (() => Date.now());
    this.onAction = options.onAction;
    this.author = options.author ?? DEFAULT_AUTHOR;
    this.token = options.token ?? null;
  }

  /** Intended actions emitted so far (dry-run audit trail). */
  listIntendedActions(): GithubIntendedAction[] {
    return [...this.intended];
  }

  /* -------------------------------------------------------------- interface */

  async checkout(input: CheckoutInput): Promise<CheckoutResult> {
    if (this.dryRun) {
      const branch = input.ref ?? (await this.defaultBranch(input.repo));
      const commit = this.syntheticSha(input.repo, `checkout:${branch}`);
      this.record('checkout', input.repo, { ref: branch, commit });
      return {
        repo: input.repo,
        commit,
        branch,
        files: { 'README.md': `# ${input.repo.name} (dry run)\n` },
      };
    }

    const info = await this.repoInfo(input.repo);
    const ref = input.ref ?? info.defaultBranch;
    const resolved = await this.resolveRef(input.repo, ref);
    const files = await this.snapshot(input.repo, resolved.sha);
    return { repo: input.repo, commit: resolved.sha, branch: resolved.branch, files };
  }

  async createBranch(input: CreateBranchInput): Promise<BranchRef> {
    const defaultBranch = await this.defaultBranch(input.repo);
    if (input.name === defaultBranch) {
      throw new ForgeError(
        'protected_branch',
        `cannot create "${input.name}": the default branch is protected`,
        { repo: repoKey(input.repo), branch: input.name },
      );
    }

    if (this.dryRun) {
      const commit = this.syntheticSha(input.repo, `branch:${input.name}`);
      this.record('branch.create', input.repo, { name: input.name, from: input.from ?? defaultBranch, commit });
      return { repo: input.repo, name: input.name, commit };
    }

    const existing = await this.tryRef(input.repo, input.name);
    if (existing) return { repo: input.repo, name: input.name, commit: existing.sha };

    const from = await this.resolveRef(input.repo, input.from ?? defaultBranch);
    if (this.flavor === 'gitea') {
      // Gitea has no "create git ref" endpoint; `POST /branches` is its equivalent.
      await this.request('POST', `/repos/${input.repo.owner}/${input.repo.name}/branches`, {
        body: { new_branch_name: input.name, old_branch_name: from.branch },
      });
      this.record('branch.create', input.repo, { name: input.name, from: from.sha });
      return { repo: input.repo, name: input.name, commit: from.sha };
    }

    await this.request('POST', `/repos/${input.repo.owner}/${input.repo.name}/git/refs`, {
      body: { ref: `refs/heads/${input.name}`, sha: from.sha },
    });
    this.record('branch.create', input.repo, { name: input.name, from: from.sha });
    return { repo: input.repo, name: input.name, commit: from.sha };
  }

  async commit(input: CommitInput): Promise<CommitRef> {
    const defaultBranch = await this.defaultBranch(input.repo);
    if (input.branch === defaultBranch) {
      throw new ForgeError(
        'protected_branch',
        `cannot commit to "${input.branch}": agents never push to the default branch`,
        { repo: repoKey(input.repo), branch: input.branch },
      );
    }

    const author = input.author ?? this.author;
    if (this.dryRun) {
      const sha = this.syntheticSha(input.repo, `commit:${input.branch}:${input.message}`);
      this.record('commit', input.repo, {
        branch: input.branch,
        message: input.message,
        files: input.files.map((file) => file.path),
        sha,
      });
      const files: Record<string, string> = {};
      for (const change of input.files) if (change.content !== null) files[change.path] = change.content;
      return { repo: input.repo, sha, branch: input.branch, message: input.message, files, author, at: this.now() };
    }

    const head = await this.tryRef(input.repo, input.branch);
    if (!head) {
      throw new ForgeError('not_found', `branch "${input.branch}" does not exist`, {
        repo: repoKey(input.repo),
        branch: input.branch,
      });
    }

    if (this.flavor === 'gitea') {
      const sha = await this.giteaCommitFiles(input.repo, input.branch, input.files, input.message, author);
      this.record('commit', input.repo, { branch: input.branch, message: input.message, sha });
      const files = await this.snapshot(input.repo, sha);
      return {
        repo: input.repo,
        sha,
        branch: input.branch,
        message: input.message,
        files,
        author,
        at: this.now(),
      };
    }

    const parent = await this.request<{ sha: string; commit: { tree: { sha: string } } }>(
      'GET',
      `/repos/${input.repo.owner}/${input.repo.name}/commits/${head.sha}`,
    );

    const blobs = await Promise.all(
      input.files.map(async (change) => ({
        path: change.path,
        sha: change.content === null ? null : await this.createBlob(input.repo, change.content),
      })),
    );

    const tree = await this.request<{ sha: string }>(
      'POST',
      `/repos/${input.repo.owner}/${input.repo.name}/git/trees`,
      {
        body: {
          base_tree: parent.commit.tree.sha,
          tree: blobs.map((blob) => ({
            path: blob.path,
            mode: '100644',
            type: 'blob',
            sha: blob.sha,
          })),
        },
      },
    );

    const created = await this.request<{ sha: string }>(
      'POST',
      `/repos/${input.repo.owner}/${input.repo.name}/git/commits`,
      {
        body: {
          message: input.message,
          tree: tree.sha,
          parents: [head.sha],
          author: { name: author.name, email: author.email, date: new Date(this.now()).toISOString() },
        },
      },
    );

    await this.request(
      'PATCH',
      `/repos/${input.repo.owner}/${input.repo.name}/git/refs/heads/${input.branch}`,
      { body: { sha: created.sha, force: false } },
    );

    this.record('commit', input.repo, { branch: input.branch, message: input.message, sha: created.sha });
    const files = await this.snapshot(input.repo, created.sha);
    return {
      repo: input.repo,
      sha: created.sha,
      branch: input.branch,
      message: input.message,
      files,
      author,
      at: this.now(),
    };
  }

  async openPullRequest(input: OpenPullRequestInput): Promise<PullRequest> {
    const defaultBranch = await this.defaultBranch(input.repo);
    const base = input.base ?? defaultBranch;
    if (input.head === defaultBranch) {
      throw new ForgeError('protected_branch', 'a pull request cannot come from the default branch', {
        repo: repoKey(input.repo),
        branch: input.head,
      });
    }

    const body = input.body ?? '';
    const withMarker = input.workItemId
      ? `${body}\n\n<!-- factory-work-item: ${input.workItemId} -->`
      : body;

    if (this.dryRun) {
      const number = this.syntheticNumber(input.repo, input.head);
      this.record('pull.open', input.repo, {
        head: input.head,
        base,
        title: input.title,
        workItemId: input.workItemId ?? null,
        number,
      });
      return {
        id: `${repoKey(input.repo)}#${number}`,
        number,
        repo: input.repo,
        head: input.head,
        base,
        title: input.title,
        body,
        url: `${this.baseUrl.replace('api.github.com', 'github.com')}/${input.repo.owner}/${input.repo.name}/pull/${number}`,
        state: 'open',
        ...(input.workItemId ? { workItemId: input.workItemId } : {}),
        createdAt: this.now(),
      };
    }

    // Idempotent: a retried activity must not open a second PR for the same head.
    if (this.flavor === 'gitea') {
      // Gitea ignores `head`/`base` filters on the list endpoint, so filter here.
      const open = await this.request<GithubPullResponse[]>(
        'GET',
        `/repos/${input.repo.owner}/${input.repo.name}/pulls?state=open&limit=50`,
      );
      const match = open.find((pull) => {
        if (pull.head.ref !== input.head || pull.base.ref !== base) return false;
        if (input.workItemId) return this.workItemOf(pull) === input.workItemId;
        return true;
      });
      if (match) return this.mapPull(input.repo, match);
    } else {
      const existing = await this.request<GithubPullResponse[]>(
        'GET',
        `/repos/${input.repo.owner}/${input.repo.name}/pulls?head=${encodeURIComponent(
          `${input.repo.owner}:${input.head}`,
        )}&base=${encodeURIComponent(base)}&state=open`,
      );
      const match = existing.find((pull) => {
        if (input.workItemId) return this.workItemOf(pull) === input.workItemId;
        return pull.head.ref === input.head;
      });
      if (match) return this.mapPull(input.repo, match);
    }

    const created = await this.request<GithubPullResponse>(
      'POST',
      `/repos/${input.repo.owner}/${input.repo.name}/pulls`,
      {
        body: {
          head: input.head,
          base,
          title: input.title,
          body: withMarker,
          draft: input.draft ?? false,
        },
      },
    );
    this.record('pull.open', input.repo, { head: input.head, base, number: created.number });
    return this.mapPull(input.repo, created);
  }

  async comment(input: CommentInput): Promise<Comment> {
    if (this.dryRun) {
      this.record('comment', input.repo, { pullRequestNumber: input.pullRequestNumber, body: input.body });
      return {
        id: `comment-dry-${this.syntheticNumber(input.repo, String(input.pullRequestNumber))}`,
        repo: input.repo,
        pullRequestNumber: input.pullRequestNumber,
        body: input.body,
        author: input.author ?? 'factory-agent',
        createdAt: this.now(),
      };
    }

    const created = await this.request<{ id: number; body: string; created_at: string; user: { login: string } }>(
      'POST',
      `/repos/${input.repo.owner}/${input.repo.name}/issues/${input.pullRequestNumber}/comments`,
      { body: { body: input.body } },
    );
    this.record('comment', input.repo, { pullRequestNumber: input.pullRequestNumber });
    return {
      id: String(created.id),
      repo: input.repo,
      pullRequestNumber: input.pullRequestNumber,
      body: created.body,
      author: input.author ?? created.user?.login ?? 'factory-agent',
      createdAt: Date.parse(created.created_at) || this.now(),
    };
  }

  async getChecks(input: GetChecksInput): Promise<ChecksResult> {
    if (this.dryRun) {
      const ref = input.ref ?? `pr-${input.pullRequestNumber ?? 'dry'}`;
      return {
        repo: input.repo,
        ref,
        checks: [
          { name: 'ci', conclusion: 'success' },
          { name: 'lint', conclusion: 'success' },
        ],
        green: true,
      };
    }

    const sha = await this.shaForChecks(input);

    if (this.flavor === 'gitea') {
      // Gitea has no check-runs API: commit statuses are the equivalent signal. A forge
      // with no CI configured reports an empty status set, which is green — nothing is
      // red, so the loop's verify stage does not deadlock on a forge that has no Actions.
      const response = await this.request<GiteaStatusResponse>(
        'GET',
        `/repos/${input.repo.owner}/${input.repo.name}/commits/${sha}/status`,
      );
      const statuses = response.statuses ?? [];
      const checks: CheckRun[] = statuses.map((status) => ({
        name: status.context ?? status.description ?? 'status',
        conclusion: giteaConclusion(status.status),
        ...(status.target_url ? { url: status.target_url } : {}),
      }));
      return {
        repo: input.repo,
        ref: input.ref ?? sha,
        checks,
        green:
          checks.length === 0 ||
          checks.every((check) => check.conclusion === 'success' || check.conclusion === 'skipped'),
      };
    }

    const response = await this.request<{
      check_runs: { name: string; conclusion: string | null; details_url?: string; status: string }[];
    }>('GET', `/repos/${input.repo.owner}/${input.repo.name}/commits/${sha}/check-runs`);

    const checks: CheckRun[] = response.check_runs.map((run) => ({
      name: run.name,
      conclusion: (run.conclusion ?? (run.status === 'in_progress' ? 'pending' : 'neutral')) as CheckRun['conclusion'],
      ...(run.details_url ? { url: run.details_url } : {}),
    }));

    return {
      repo: input.repo,
      ref: input.ref ?? sha,
      checks,
      green: checks.length > 0 && checks.every((check) => check.conclusion === 'success' || check.conclusion === 'skipped'),
    };
  }

  async merge(input: MergeInput): Promise<MergeResult> {
    if (this.dryRun) {
      const pull = this.syntheticPull(input.repo, input.pullRequestNumber);
      this.record('merge', input.repo, {
        pullRequestNumber: input.pullRequestNumber,
        method: input.method ?? 'merge',
      });
      return { merged: true, sha: this.syntheticSha(input.repo, `merge:${input.pullRequestNumber}`), pullRequest: pull };
    }

    // Read the PR first so an already-merged PR is `invalid_state`, not a GitHub 405.
    const current = await this.request<GithubPullResponse>(
      'GET',
      `/repos/${input.repo.owner}/${input.repo.name}/pulls/${input.pullRequestNumber}`,
    );
    if (current.state !== 'open' || current.merged) {
      throw new ForgeError('invalid_state', `pull request #${input.pullRequestNumber} is ${current.merged ? 'merged' : current.state}`, {
        repo: repoKey(input.repo),
        pullRequestNumber: input.pullRequestNumber,
        state: current.merged ? 'merged' : current.state,
      });
    }

    let response: { merged?: boolean; sha?: string; message?: string };
    try {
      if (this.flavor === 'gitea') {
        // Gitea merges with POST + `Do` (not PUT + `merge_method`); a 200 means merged and
        // the response body may be empty, so the merge commit comes from the PR itself.
        response = await this.request<{ merged?: boolean; sha?: string; message?: string }>(
          'POST',
          `/repos/${input.repo.owner}/${input.repo.name}/pulls/${input.pullRequestNumber}/merge`,
          { body: { Do: giteaMergeStyle(input.method) } },
        );
      } else {
        response = await this.request<{ merged?: boolean; sha?: string; message?: string }>(
          'PUT',
          `/repos/${input.repo.owner}/${input.repo.name}/pulls/${input.pullRequestNumber}/merge`,
          { body: { merge_method: input.method ?? 'merge' } },
        );
      }
    } catch (error) {
      // GitHub reports "not mergeable" (checks red / conflict) as 405 or 409.
      if (error instanceof ForgeError && (error.code === 'not_found' || error.code === 'invalid_state')) {
        const status = (error.details as { status?: number } | undefined)?.status;
        if (status === 405 || status === 409) {
          throw new ForgeError('checks_not_green', 'merge refused: required checks are not green or the branch conflicts', {
            repo: repoKey(input.repo),
            pullRequestNumber: input.pullRequestNumber,
            status,
          });
        }
      }
      throw error;
    }

    const merged = await this.request<GithubPullResponse>(
      'GET',
      `/repos/${input.repo.owner}/${input.repo.name}/pulls/${input.pullRequestNumber}`,
    );

    if (this.flavor === 'gitea') {
      if (!merged.merged && !merged.merged_at) {
        throw new ForgeError('checks_not_green', response.message ?? 'merge refused: the pull request is not mergeable', {
          repo: repoKey(input.repo),
          pullRequestNumber: input.pullRequestNumber,
        });
      }
      this.record('merge', input.repo, { pullRequestNumber: input.pullRequestNumber, sha: merged.merge_commit_sha ?? null });
      return {
        merged: true,
        sha: merged.merge_commit_sha ?? merged.head.sha,
        pullRequest: this.mapPull(input.repo, merged),
      };
    }

    if (!response.merged) {
      throw new ForgeError('checks_not_green', response.message ?? 'merge refused: the pull request is not mergeable', {
        repo: repoKey(input.repo),
        pullRequestNumber: input.pullRequestNumber,
      });
    }

    this.record('merge', input.repo, { pullRequestNumber: input.pullRequestNumber, sha: response.sha ?? null });
    return {
      merged: true,
      sha: response.sha ?? merged.head.sha,
      pullRequest: this.mapPull(input.repo, merged),
    };
  }

  async revert(input: RevertInput): Promise<RevertResult> {
    const defaultBranch = await this.defaultBranch(input.repo);
    const author = input.author ?? this.author;
    const message = input.message ?? `Revert to ${input.toSha.slice(0, 8)}`;

    if (this.dryRun) {
      const sha = this.syntheticSha(input.repo, `revert:${input.toSha}`);
      this.record('revert', input.repo, { toSha: input.toSha, message, sha });
      return { repo: input.repo, sha, branch: defaultBranch, revertedTo: input.toSha };
    }

    if (this.flavor === 'gitea') {
      // Gitea has no "create commit from tree" API, so a revert restores the target tree
      // through the contents API: every differing file is written, every file that only
      // exists now is deleted. Each write is a commit on the default branch (a revert may
      // be several commits, but the tree ends exactly at `toSha`).
      const head = await this.resolveRef(input.repo, defaultBranch);
      const target = await this.snapshot(input.repo, input.toSha);
      const current = await this.snapshot(input.repo, head.sha);
      const changes: FileChange[] = [];
      for (const path of Object.keys(current)) {
        if (!(path in target)) changes.push({ path, content: null });
      }
      for (const [path, content] of Object.entries(target)) {
        if (current[path] !== content) changes.push({ path, content });
      }
      const sha =
        changes.length === 0
          ? head.sha
          : await this.giteaCommitFiles(input.repo, defaultBranch, changes, message, author);
      this.record('revert', input.repo, { toSha: input.toSha, sha });
      return { repo: input.repo, sha, branch: defaultBranch, revertedTo: input.toSha };
    }

    const head = await this.resolveRef(input.repo, defaultBranch);
    const target = await this.request<{ commit: { tree: { sha: string } } }>(
      'GET',
      `/repos/${input.repo.owner}/${input.repo.name}/commits/${input.toSha}`,
    );

    const created = await this.request<{ sha: string }>(
      'POST',
      `/repos/${input.repo.owner}/${input.repo.name}/git/commits`,
      {
        body: {
          message,
          tree: target.commit.tree.sha,
          parents: [head.sha],
          author: { name: author.name, email: author.email, date: new Date(this.now()).toISOString() },
        },
      },
    );
    await this.request(
      'PATCH',
      `/repos/${input.repo.owner}/${input.repo.name}/git/refs/heads/${defaultBranch}`,
      { body: { sha: created.sha, force: false } },
    );
    this.record('revert', input.repo, { toSha: input.toSha, sha: created.sha });
    return { repo: input.repo, sha: created.sha, branch: defaultBranch, revertedTo: input.toSha };
  }

  /* -------------------------------------------------------------- transport */

  private tokenValue(): string {
    if (this.token) return this.token;
    const resolved = this.resolveSecret(this.secretRef);
    if (!resolved) {
      throw new ForgeError(
        'auth_failed',
        `secret "${this.secretRef}" is not configured; the GitHub credential is resolved by reference`,
        { secretRef: this.secretRef },
      );
    }
    this.token = resolved;
    return resolved;
  }

  private async repoInfo(repo: RepoRef): Promise<GithubRepoInfo> {
    const key = repoKey(repo);
    const cached = this.repos.get(key);
    if (cached) return cached;
    const response = await this.request<{ default_branch: string }>('GET', `/repos/${repo.owner}/${repo.name}`);
    const info = { defaultBranch: response.default_branch };
    this.repos.set(key, info);
    return info;
  }

  private async defaultBranch(repo: RepoRef): Promise<string> {
    if (this.dryRun) {
      const key = repoKey(repo);
      return this.repos.get(key)?.defaultBranch ?? 'main';
    }
    return (await this.repoInfo(repo)).defaultBranch;
  }

  private async tryRef(repo: RepoRef, ref: string): Promise<{ sha: string } | null> {
    try {
      if (this.flavor === 'gitea') {
        // Gitea serves refs under `git/refs/...` and answers with an array.
        const refs = await this.request<GiteaRefResponse[]>(
          'GET',
          `/repos/${repo.owner}/${repo.name}/git/refs/heads/${ref}`,
          { allow404: true },
        );
        const first = Array.isArray(refs) ? refs[0] : undefined;
        return first ? { sha: first.object.sha } : null;
      }
      const response = await this.request<{ object: { sha: string } }>(
        'GET',
        `/repos/${repo.owner}/${repo.name}/git/ref/heads/${ref}`,
        { allow404: true },
      );
      return { sha: response.object.sha };
    } catch (error) {
      if (error instanceof ForgeError && error.code === 'not_found') return null;
      throw error;
    }
  }

  /** Resolves a branch name or a commit SHA to `{sha, branch}`. */
  private async resolveRef(repo: RepoRef, ref: string): Promise<{ sha: string; branch: string }> {
    const branch = await this.tryRef(repo, ref);
    if (branch) return { sha: branch.sha, branch: ref };

    if (/^[0-9a-f]{7,40}$/.test(ref)) {
      const path =
        this.flavor === 'gitea'
          ? `/repos/${repo.owner}/${repo.name}/git/commits/${ref}`
          : `/repos/${repo.owner}/${repo.name}/commits/${ref}`;
      const commit = await this.request<{ sha: string }>('GET', path, { allow404: true });
      return { sha: commit.sha, branch: 'HEAD' };
    }

    throw new ForgeError('not_found', `unknown ref "${ref}"`, { repo: repoKey(repo), ref });
  }

  private async shaForChecks(input: GetChecksInput): Promise<string> {
    if (input.pullRequestNumber !== undefined) {
      const pull = await this.request<GithubPullResponse>(
        'GET',
        `/repos/${input.repo.owner}/${input.repo.name}/pulls/${input.pullRequestNumber}`,
      );
      return pull.head.sha;
    }
    const resolved = await this.resolveRef(input.repo, input.ref ?? (await this.defaultBranch(input.repo)));
    return resolved.sha;
  }

  private async createBlob(repo: RepoRef, content: string): Promise<string> {
    const created = await this.request<{ sha: string }>('POST', `/repos/${repo.owner}/${repo.name}/git/blobs`, {
      body: { content, encoding: 'utf-8' },
    });
    return created.sha;
  }

  /** Path → content snapshot at a commit (tree + blobs, blobs cached by SHA). */
  private async snapshot(repo: RepoRef, sha: string): Promise<Record<string, string>> {
    const tree = await this.request<GithubTreeResponse>(
      'GET',
      `/repos/${repo.owner}/${repo.name}/git/trees/${sha}?recursive=1`,
    );
    const blobs = tree.tree.filter((entry) => entry.type === 'blob');
    const files: Record<string, string> = {};
    for (const entry of blobs) {
      const blob = await this.request<{ content: string; encoding: string }>(
        'GET',
        `/repos/${repo.owner}/${repo.name}/git/blobs/${entry.sha}`,
      );
      files[entry.path] =
        blob.encoding === 'base64' ? Buffer.from(blob.content, 'base64').toString('utf8') : blob.content;
    }
    return files;
  }

  /* ------------------------------------------------------------ gitea dialect */

  /**
   * Gitea/Forgejo has no "write blob/tree/commit/ref" API (those endpoints are read-only),
   * so a commit is written through the contents API: one commit per changed file, in
   * order, on the target branch. The returned SHA is the branch head after the last write.
   */
  private async giteaCommitFiles(
    repo: RepoRef,
    branch: string,
    files: FileChange[],
    message: string,
    author: { name: string; email: string },
  ): Promise<string> {
    const head = await this.tryRef(repo, branch);
    if (!head) {
      throw new ForgeError('not_found', `branch "${branch}" does not exist`, { repo: repoKey(repo), branch });
    }

    let sha = head.sha;
    for (const change of files) {
      const encodedPath = change.path.split('/').map(encodeURIComponent).join('/');
      const resource = `/repos/${repo.owner}/${repo.name}/contents/${encodedPath}`;
      const existing = await this.giteaFile(repo, branch, change.path);

      if (change.content === null) {
        if (!existing) continue;
        const deleted = await this.request<GiteaWriteResponse>('DELETE', resource, {
          body: { message, branch, sha: existing.sha },
        });
        sha = deleted.commit.sha;
        continue;
      }

      const content = Buffer.from(change.content, 'utf8').toString('base64');
      if (existing) {
        // A retried activity must not add an empty commit for unchanged content.
        if (existing.content.replace(/\s+/g, '') === content) continue;
        const updated = await this.request<GiteaWriteResponse>('PUT', resource, {
          body: { message, branch, sha: existing.sha, content, author },
        });
        sha = updated.commit.sha;
      } else {
        const created = await this.request<GiteaWriteResponse>('POST', resource, {
          body: { message, branch, content, author },
        });
        sha = created.commit.sha;
      }
    }
    return sha;
  }

  /** Current file on a branch (`null` when it does not exist). */
  private async giteaFile(
    repo: RepoRef,
    branch: string,
    path: string,
  ): Promise<{ sha: string; content: string } | null> {
    const encodedPath = path.split('/').map(encodeURIComponent).join('/');
    try {
      const file = await this.request<GiteaContentResponse>(
        'GET',
        `/repos/${repo.owner}/${repo.name}/contents/${encodedPath}?ref=${encodeURIComponent(branch)}`,
        { allow404: true },
      );
      return { sha: file.sha, content: file.content ?? '' };
    } catch (error) {
      if (error instanceof ForgeError && error.code === 'not_found') return null;
      throw error;
    }
  }

  private async request<T>(
    method: string,
    path: string,
    options: { body?: unknown; allow404?: boolean } = {},
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const cacheKey = `${method} ${path}`;
    const cached = this.etags.get(cacheKey);

    const headers: Record<string, string> = {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      authorization: `Bearer ${this.tokenValue()}`,
      'user-agent': 'software-factory',
    };
    if (method === 'GET' && cached) headers['if-none-match'] = cached.etag;
    if (options.body !== undefined) headers['content-type'] = 'application/json';

    let attempt = 0;
    let rateLimitAttempts = 0;

    for (;;) {
      let response: GithubResponseLike;
      try {
        response = await this.fetchImpl(url, {
          method,
          headers,
          ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        });
      } catch (error) {
        if (attempt >= this.maxRetries) throw error;
        await this.sleep(this.backoffMs(attempt));
        attempt += 1;
        continue;
      }

      if (response.status === 304 && cached) return cached.body as T;

      if (response.ok) {
        // Gitea answers some writes (e.g. a merge) with an empty body; treat that as `{}`.
        let body: unknown;
        try {
          body = await response.json();
        } catch {
          body = {};
        }
        if (method === 'GET') {
          const etag = response.headers.get('etag');
          if (etag) this.etags.set(cacheKey, { etag, body });
        }
        return body as T;
      }

      const remaining = response.headers.get('x-ratelimit-remaining');
      const retryAfter = response.headers.get('retry-after');
      const rateLimited =
        response.status === 429 ||
        (response.status === 403 && (remaining === '0' || retryAfter !== null));

      if (rateLimited) {
        const resetAt = this.resetAt(response.headers);
        const waitMs = retryAfter !== null ? Number(retryAfter) * 1000 : Math.max(0, resetAt - this.now());
        if (rateLimitAttempts < this.maxRateLimitRetries && waitMs <= this.maxBackoffMs) {
          await this.sleep(waitMs);
          rateLimitAttempts += 1;
          continue;
        }
        throw new ForgeError('rate_limited', 'GitHub rate limit exhausted', {
          resetAt,
          remaining: remaining === null ? null : Number(remaining),
          retryAfterMs: waitMs,
        });
      }

      if (response.status >= 500) {
        if (attempt >= this.maxRetries) {
          throw new ForgeError('invalid_state', `GitHub returned ${response.status}`, { status: response.status });
        }
        await this.sleep(this.backoffMs(attempt));
        attempt += 1;
        continue;
      }

      throw this.mapError(response, options.allow404 ?? false);
    }
  }

  private backoffMs(attempt: number): number {
    return Math.min(this.maxBackoffMs, 250 * 2 ** attempt);
  }

  private resetAt(headers: GithubResponseLike['headers']): number {
    const reset = headers.get('x-ratelimit-reset');
    if (reset) {
      const seconds = Number(reset);
      if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
    }
    const retryAfter = headers.get('retry-after');
    if (retryAfter) return this.now() + Number(retryAfter) * 1000;
    return this.now() + 60_000;
  }

  private mapError(response: GithubResponseLike, allow404: boolean): ForgeError {
    const details = { status: response.status };
    if (response.status === 401 || response.status === 403) {
      return new ForgeError('auth_failed', `GitHub rejected the credential (${response.status})`, {
        ...details,
        missingScope: response.headers.get('x-accepted-github-permissions') ?? undefined,
      });
    }
    if (response.status === 404) {
      if (allow404) return new ForgeError('not_found', 'not found', details);
      return new ForgeError('not_found', 'repository, branch, commit or pull request does not exist', details);
    }
    if (response.status === 405 || response.status === 409) {
      return new ForgeError('invalid_state', `GitHub refused the operation (${response.status})`, details);
    }
    if (response.status === 422) {
      return new ForgeError('invalid_state', 'GitHub rejected the payload (422)', details);
    }
    return new ForgeError('invalid_state', `GitHub returned ${response.status}`, details);
  }

  /* ---------------------------------------------------------------- helpers */

  private mapPull(repo: RepoRef, pull: GithubPullResponse): PullRequest {
    const workItemId = this.workItemOf(pull);
    return {
      id: `${repoKey(repo)}#${pull.number}`,
      number: pull.number,
      repo,
      head: pull.head.ref,
      base: pull.base.ref,
      title: pull.title,
      body: (pull.body ?? '').replace(WORK_ITEM_MARKER, '').trim(),
      url: pull.html_url,
      state: pull.merged || pull.merged_at ? 'merged' : pull.state === 'closed' ? 'closed' : 'open',
      ...(workItemId ? { workItemId } : {}),
      createdAt: Date.parse(pull.created_at) || this.now(),
    };
  }

  private workItemOf(pull: GithubPullResponse): string | undefined {
    const match = WORK_ITEM_MARKER.exec(pull.body ?? '');
    return match?.[1];
  }

  private record(action: GithubActionName, repo: RepoRef, detail: Record<string, unknown>): void {
    if (!this.dryRun) return;
    const intended: GithubIntendedAction = {
      type: 'github.intended_action',
      action,
      repo: repoKey(repo),
      at: this.now(),
      detail,
    };
    this.intended.push(intended);
    this.onAction?.(intended);
  }

  private syntheticSha(repo: RepoRef, seed: string): string {
    return createHash('sha1').update(`dry-run\u0000${repoKey(repo)}\u0000${seed}`).digest('hex');
  }

  private syntheticNumber(repo: RepoRef, seed: string): number {
    const digest = createHash('sha1').update(`dry-run\u0000${repoKey(repo)}\u0000${seed}`).digest();
    return (digest[0]! % 90) + 1;
  }

  private syntheticPull(repo: RepoRef, number: number): PullRequest {
    return {
      id: `${repoKey(repo)}#${number}`,
      number,
      repo,
      head: `factory/${number}`,
      base: 'main',
      title: `dry-run pull request #${number}`,
      body: '',
      url: `https://github.com/${repo.owner}/${repo.name}/pull/${number}`,
      state: 'merged',
      createdAt: this.now(),
    };
  }
}

/** Convenience: a backend configured from the environment (secret by reference). */
export function githubForgeFromEnv(options: GithubForgeOptions = {}): GitHubForge {
  return new GitHubForge({
    secretRef: process.env.GITHUB_SECRET_REF ?? 'GITHUB_TOKEN',
    // Forgejo exposes the Gitea-compatible API under /api/v1; the dialect is detected
    // from the host, so pointing this at a forge is all a deployment needs to do.
    ...(process.env.GITHUB_API_BASE_URL ? { baseUrl: process.env.GITHUB_API_BASE_URL } : {}),
    dryRun: process.env.GITHUB_DRY_RUN === '1',
    ...options,
  });
}

export function isGithubDryRun(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.GITHUB_DRY_RUN === '1';
}

/** Exported for the fixture stub: the marker GitHubForge writes on a pull request body. */
export const GITHUB_WORK_ITEM_MARKER = WORK_ITEM_MARKER;

export function githubPullBody(body: string, workItemId?: string): string {
  return workItemId ? `${body}\n\n<!-- factory-work-item: ${workItemId} -->` : body;
}

export function isGithubResponse(value: unknown): value is GithubResponseLike {
  return isRecord(value) && typeof value.status === 'number';
}
