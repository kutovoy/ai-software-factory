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
 * In-memory code forge used by tests, demos and the fake-harness loop.
 *
 * It is deliberately deterministic:
 *  - commit SHAs are content hashes, so the same change produces the same SHA;
 *  - pull request numbers are sequential per repo;
 *  - checks default to green, and are red when the PR title/body carries `[red]`
 *    (or when `simulateChecks` is called) — the "deterministic red-check simulation".
 *
 * `protected_branch` is enforced on every write: agents can never commit to (or create)
 * the default branch. Merging *into* the default branch is the only allowed write there,
 * and only when checks are green.
 */

type StoredCommit = CommitRef;

interface RepoState {
  defaultBranch: string;
  branches: Map<string, string>;
  /**
   * Commit each branch was created from. A merge applies the branch's *diff* since this
   * base onto the target, like a real forge — so merging two branches in sequence keeps
   * both changes (a batch merge must not lose the first PR's files).
   */
  branchBases: Map<string, string>;
  commits: Map<string, StoredCommit>;
  pulls: PullRequest[];
  comments: Comment[];
  checksByPull: Map<number, CheckRun[]>;
  checksByRef: Map<string, CheckRun[]>;
}

export interface FakeForgeOptions {
  /** Default branch name; protected. Defaults to `main`. */
  defaultBranch?: string;
  /** Marker that makes the default checks red. Defaults to `[red]`. */
  redCheckMarker?: string;
  /** Author recorded on commits when the caller does not provide one. */
  author?: { name: string; email: string };
  /**
   * Stack-check hook for the merge queue: a default-branch tree containing this path is
   * "red" (a semantic conflict: every PR is green alone, the merged stack is not).
   */
  stackRedMarker?: string;
}

const DEFAULT_AUTHOR = { name: 'factory-agent', email: 'agent@factory.local' };

export class FakeForge implements CodeForge {
  readonly id = 'fake' as const;

  private readonly defaultBranch: string;
  private readonly redCheckMarker: string;
  private readonly author: { name: string; email: string };
  private readonly stackRedMarker: string;
  private stackPending = false;
  private readonly repos = new Map<string, RepoState>();
  private clock = 1;

  constructor(options: FakeForgeOptions = {}) {
    this.defaultBranch = options.defaultBranch ?? 'main';
    this.redCheckMarker = options.redCheckMarker ?? '[red]';
    this.author = options.author ?? DEFAULT_AUTHOR;
    this.stackRedMarker = options.stackRedMarker ?? '.ci-fail';
  }

  /* -------------------------------------------------------------- lifecycle */

  /** Creates an empty repo with a root commit on the default branch. */
  seedRepo(repo: RepoRef, files: Record<string, string> = {}): void {
    const key = repoKey(repo);
    if (this.repos.has(key)) return;
    const rootSha = this.sha(key, 'root', '', JSON.stringify(files));
    const state: RepoState = {
      defaultBranch: this.defaultBranch,
      branches: new Map([[this.defaultBranch, rootSha]]),
      branchBases: new Map([[this.defaultBranch, rootSha]]),
      commits: new Map([
        [
          rootSha,
          {
            repo,
            sha: rootSha,
            branch: this.defaultBranch,
            message: 'initial commit',
            files: { ...files },
            author: this.author,
            at: this.now(),
          },
        ],
      ]),
      pulls: [],
      comments: [],
      checksByPull: new Map(),
      checksByRef: new Map(),
    };
    this.repos.set(key, state);
  }

  /** Test hook: forget every repo. */
  reset(): void {
    this.repos.clear();
  }

  /* -------------------------------------------------------------- interface */

  async checkout(input: CheckoutInput): Promise<CheckoutResult> {
    const state = this.state(input.repo);
    const sha = this.resolve(state, input.repo, input.ref ?? state.defaultBranch);
    const commit = this.commitOf(state, input.repo, sha);
    return {
      repo: input.repo,
      commit: sha,
      branch: this.branchAt(state, sha) ?? 'HEAD',
      files: { ...commit.files },
    };
  }

  async createBranch(input: CreateBranchInput): Promise<BranchRef> {
    const state = this.state(input.repo);
    if (input.name === state.defaultBranch) {
      throw new ForgeError(
        'protected_branch',
        `cannot create "${input.name}": the default branch is protected`,
        { repo: repoKey(input.repo), branch: input.name },
      );
    }
    if (state.branches.has(input.name)) {
      return { repo: input.repo, name: input.name, commit: state.branches.get(input.name)! };
    }
    const from = this.resolve(state, input.repo, input.from ?? state.defaultBranch);
    state.branches.set(input.name, from);
    state.branchBases.set(input.name, from);
    return { repo: input.repo, name: input.name, commit: from };
  }

  async commit(input: CommitInput): Promise<CommitRef> {
    const state = this.state(input.repo);
    if (input.branch === state.defaultBranch) {
      throw new ForgeError(
        'protected_branch',
        `cannot commit to "${input.branch}": agents never push to the default branch`,
        { repo: repoKey(input.repo), branch: input.branch },
      );
    }
    const parent = state.branches.get(input.branch);
    if (!parent) {
      throw new ForgeError('not_found', `branch "${input.branch}" does not exist`, {
        repo: repoKey(input.repo),
        branch: input.branch,
      });
    }

    const files = { ...this.commitOf(state, input.repo, parent).files };
    for (const change of input.files) {
      if (change.content === null) delete files[change.path];
      else files[change.path] = change.content;
    }

    const sha = this.sha(repoKey(input.repo), input.branch, input.message, JSON.stringify(files));
    const commit: StoredCommit = {
      repo: input.repo,
      sha,
      branch: input.branch,
      message: input.message,
      files,
      author: input.author ?? this.author,
      at: this.now(),
    };
    state.commits.set(sha, commit);
    state.branches.set(input.branch, sha);

    return {
      repo: commit.repo,
      sha: commit.sha,
      branch: commit.branch,
      message: commit.message,
      files: commit.files,
      author: commit.author,
      at: commit.at,
    };
  }

  async openPullRequest(input: OpenPullRequestInput): Promise<PullRequest> {
    const state = this.state(input.repo);
    if (!state.branches.has(input.head)) {
      throw new ForgeError('not_found', `branch "${input.head}" does not exist`, {
        repo: repoKey(input.repo),
        branch: input.head,
      });
    }
    if (input.head === state.defaultBranch) {
      throw new ForgeError(
        'protected_branch',
        'a pull request cannot come from the default branch',
        { repo: repoKey(input.repo), branch: input.head },
      );
    }
    const base = input.base ?? state.defaultBranch;
    if (!state.branches.has(base)) {
      throw new ForgeError('not_found', `base branch "${base}" does not exist`, {
        repo: repoKey(input.repo),
        branch: base,
      });
    }

    // Idempotent: an activity retry must not open a second PR for the same head.
    const existing = state.pulls.find(
      (pull) =>
        pull.head === input.head &&
        pull.base === base &&
        pull.state === 'open' &&
        (input.workItemId === undefined || pull.workItemId === input.workItemId),
    );
    if (existing) return existing;

    const number = state.pulls.length + 1;
    const pull: PullRequest = {
      id: `${repoKey(input.repo)}#${number}`,
      number,
      repo: input.repo,
      head: input.head,
      base,
      title: input.title,
      body: input.body ?? '',
      url: `https://forge.local/${input.repo.owner}/${input.repo.name}/pull/${number}`,
      state: 'open',
      ...(input.workItemId ? { workItemId: input.workItemId } : {}),
      createdAt: this.now(),
    };
    state.pulls.push(pull);
    state.checksByPull.set(number, this.defaultChecks(pull));
    return pull;
  }

  async comment(input: CommentInput): Promise<Comment> {
    const state = this.state(input.repo);
    const pull = state.pulls.find((candidate) => candidate.number === input.pullRequestNumber);
    if (!pull) {
      throw new ForgeError('not_found', `pull request #${input.pullRequestNumber} does not exist`, {
        repo: repoKey(input.repo),
        pullRequestNumber: input.pullRequestNumber,
      });
    }
    const comment: Comment = {
      id: `comment-${state.comments.length + 1}`,
      repo: input.repo,
      pullRequestNumber: pull.number,
      body: input.body,
      author: input.author ?? 'factory-agent',
      createdAt: this.now(),
    };
    state.comments.push(comment);
    return comment;
  }

  async getChecks(input: GetChecksInput): Promise<ChecksResult> {
    const state = this.state(input.repo);
    let ref: string;
    let checks: CheckRun[];

    if (input.pullRequestNumber !== undefined) {
      const pull = state.pulls.find(
        (candidate) => candidate.number === input.pullRequestNumber,
      );
      if (!pull) {
        throw new ForgeError('not_found', `pull request #${input.pullRequestNumber} does not exist`, {
          repo: repoKey(input.repo),
          pullRequestNumber: input.pullRequestNumber,
        });
      }
      ref = pull.head;
      checks = state.checksByPull.get(pull.number) ?? this.defaultChecks(pull);
    } else {
      ref = input.ref ?? state.defaultBranch;
      checks = this.refChecks(state, ref);
    }

    return {
      repo: input.repo,
      ref,
      checks,
      green: checks.every(
        (check) => check.conclusion === 'success' || check.conclusion === 'skipped',
      ),
    };
  }

  async merge(input: MergeInput): Promise<MergeResult> {
    const state = this.state(input.repo);
    const pull = state.pulls.find((candidate) => candidate.number === input.pullRequestNumber);
    if (!pull) {
      throw new ForgeError('not_found', `pull request #${input.pullRequestNumber} does not exist`, {
        repo: repoKey(input.repo),
        pullRequestNumber: input.pullRequestNumber,
      });
    }
    if (pull.state !== 'open') {
      throw new ForgeError('invalid_state', `pull request #${pull.number} is ${pull.state}`, {
        repo: repoKey(input.repo),
        pullRequestNumber: pull.number,
        state: pull.state,
      });
    }

    const checks = state.checksByPull.get(pull.number) ?? this.defaultChecks(pull);
    const red = checks.filter(
      (check) => check.conclusion !== 'success' && check.conclusion !== 'skipped',
    );
    if (red.length > 0) {
      throw new ForgeError('checks_not_green', 'merge refused: required checks are not green', {
        repo: repoKey(input.repo),
        pullRequestNumber: pull.number,
        failing: red.map((check) => check.name),
      });
    }

    const headSha = state.branches.get(pull.head);
    const baseSha = state.branches.get(pull.base);
    if (!headSha || !baseSha || headSha === baseSha) {
      throw new ForgeError('no_commits', 'merge refused: the branch has no commits ahead of base', {
        repo: repoKey(input.repo),
        pullRequestNumber: pull.number,
      });
    }

    // Apply the branch diff since its creation base onto the target (a real merge, not a
    // tree replacement): sequential merges keep every earlier change.
    const headFiles = this.commitOf(state, input.repo, headSha).files;
    const branchBase = state.branchBases.get(pull.head);
    const baseFiles: Record<string, string> =
      branchBase === undefined ? {} : this.commitOf(state, input.repo, branchBase).files;
    const files: Record<string, string> = { ...this.commitOf(state, input.repo, baseSha).files };
    for (const path of new Set([...Object.keys(baseFiles), ...Object.keys(headFiles)])) {
      if (baseFiles[path] === headFiles[path]) continue;
      const content = headFiles[path];
      if (content === undefined) delete files[path];
      else files[path] = content;
    }

    const mergeSha = this.sha(
      repoKey(input.repo),
      pull.base,
      `merge #${pull.number} (${input.method ?? 'merge'})`,
      headSha,
      JSON.stringify(files),
    );
    state.commits.set(mergeSha, {
      repo: input.repo,
      sha: mergeSha,
      branch: pull.base,
      message: `Merge pull request #${pull.number} from ${pull.head}`,
      files,
      author: this.author,
      at: this.now(),
    });
    state.branches.set(pull.base, mergeSha);
    pull.state = 'merged';

    return { merged: true, sha: mergeSha, pullRequest: pull };
  }

  /**
   * Reverts the default branch to a previous tree as a **new commit** (never a force-push).
   * This is the only write to the default branch other than a merge, and the merge queue
   * owns it (spec `merge-queue` › revert on red).
   */
  async revert(input: RevertInput): Promise<RevertResult> {
    const state = this.state(input.repo);
    const target = this.commitOf(state, input.repo, input.toSha);
    const message = input.message ?? `Revert to ${input.toSha}`;
    const sha = this.sha(repoKey(input.repo), state.defaultBranch, message, JSON.stringify(target.files));

    state.commits.set(sha, {
      repo: input.repo,
      sha,
      branch: state.defaultBranch,
      message,
      files: { ...target.files },
      author: input.author ?? this.author,
      at: this.now(),
    });
    state.branches.set(state.defaultBranch, sha);

    return { repo: input.repo, sha, branch: state.defaultBranch, revertedTo: input.toSha };
  }

  /* ---------------------------------------------------------- test helpers */

  /** Deterministic red/green simulation for one pull request. */
  simulateChecks(repo: RepoRef, pullRequestNumber: number, checks: CheckRun[]): void {
    const state = this.state(repo);
    if (!state.pulls.some((pull) => pull.number === pullRequestNumber)) {
      throw new ForgeError('not_found', `pull request #${pullRequestNumber} does not exist`, {
        repo: repoKey(repo),
        pullRequestNumber,
      });
    }
    state.checksByPull.set(pullRequestNumber, checks);
  }

  /** Deterministic check simulation for any ref (branch or commit). */
  simulateChecksForRef(repo: RepoRef, ref: string, checks: CheckRun[]): void {
    this.state(repo).checksByRef.set(ref, checks);
  }

  /**
   * Merge-queue hook: report `pending` for every default-branch ref so a stack gate can be
   * driven into `checks_timeout` deterministically.
   */
  setStackPending(pending: boolean): void {
    this.stackPending = pending;
  }

  listPullRequests(repo: RepoRef): PullRequest[] {
    return [...this.state(repo).pulls];
  }

  listComments(repo: RepoRef, pullRequestNumber: number): Comment[] {
    return this.state(repo).comments.filter(
      (comment) => comment.pullRequestNumber === pullRequestNumber,
    );
  }

  defaultBranchOf(repo: RepoRef): string {
    return this.state(repo).defaultBranch;
  }

  /* -------------------------------------------------------------- internals */

  private state(repo: RepoRef): RepoState {
    const state = this.repos.get(repoKey(repo));
    if (!state) {
      throw new ForgeError('not_found', `repository ${repoKey(repo)} does not exist`, {
        repo: repoKey(repo),
      });
    }
    return state;
  }

  private resolve(state: RepoState, repo: RepoRef, ref: string): string {
    const branch = state.branches.get(ref);
    if (branch) return branch;
    if (state.commits.has(ref)) return ref;
    throw new ForgeError('not_found', `unknown ref "${ref}"`, { repo: repoKey(repo), ref });
  }

  private commitOf(state: RepoState, repo: RepoRef, sha: string): StoredCommit {
    const commit = state.commits.get(sha);
    if (!commit) {
      throw new ForgeError('not_found', `unknown commit ${sha}`, { repo: repoKey(repo), sha });
    }
    return commit;
  }

  private branchAt(state: RepoState, sha: string): string | undefined {
    for (const [name, head] of state.branches) {
      if (head === sha) return name;
    }
    return undefined;
  }

  /**
   * Checks for a branch/commit ref. Explicit simulations win; otherwise the tree decides:
   * a `.ci-fail` marker (semantic conflict) is red, `setStackPending` is pending, else green.
   */
  private refChecks(state: RepoState, ref: string): CheckRun[] {
    const explicit = state.checksByRef.get(ref);
    if (explicit) return explicit;
    if (this.stackPending) return [{ name: 'ci', conclusion: 'pending' }];
    const sha = state.branches.get(ref) ?? (state.commits.has(ref) ? ref : null);
    const files = sha ? state.commits.get(sha)?.files : undefined;
    if (files && this.stackRedMarker in files) {
      return [
        { name: 'ci', conclusion: 'failure' },
        { name: 'lint', conclusion: 'success' },
      ];
    }
    return [{ name: 'ci', conclusion: 'success' }];
  }

  private defaultChecks(pull: PullRequest): CheckRun[] {
    const text = `${pull.title}\n${pull.body}`;
    if (text.includes(this.redCheckMarker)) {
      return [
        { name: 'ci', conclusion: 'failure' },
        { name: 'lint', conclusion: 'success' },
      ];
    }
    return [
      { name: 'ci', conclusion: 'success' },
      { name: 'lint', conclusion: 'success' },
    ];
  }

  private sha(...parts: string[]): string {
    return createHash('sha1').update(parts.join('\u0000')).digest('hex');
  }

  private now(): number {
    this.clock += 1;
    return this.clock;
  }
}
