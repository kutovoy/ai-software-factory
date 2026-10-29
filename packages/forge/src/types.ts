/**
 * The code-forge boundary. Everything the factory loop does to a repository goes
 * through this interface: branch, commit, pull request, checks, merge. The fake backend
 * is used by tests and demos; the GitHub backend (3b) implements the same contract.
 *
 * Every method is async so a transport (HTTP, git) can be swapped in without changing
 * call sites.
 */

export interface RepoRef {
  owner: string;
  name: string;
}

export function repoKey(repo: RepoRef): string {
  return `${repo.owner}/${repo.name}`;
}

export interface CheckoutInput {
  repo: RepoRef;
  /** Commit, branch or tag; defaults to the default branch head. */
  ref?: string;
}

export interface CheckoutResult {
  repo: RepoRef;
  /** Resolved commit SHA. */
  commit: string;
  /** Branch the checkout is on (`HEAD` detached when a bare commit was requested). */
  branch: string;
  /** Path -> content snapshot at the commit. */
  files: Record<string, string>;
}

export interface CreateBranchInput {
  repo: RepoRef;
  name: string;
  /** Commit/branch to branch from; defaults to the default branch head. */
  from?: string;
}

export interface BranchRef {
  repo: RepoRef;
  name: string;
  commit: string;
}

export interface FileChange {
  path: string;
  /** New content; `null` deletes the file. */
  content: string | null;
}

export interface CommitInput {
  repo: RepoRef;
  /** Target branch. Must not be the default branch (`protected_branch`). */
  branch: string;
  message: string;
  files: FileChange[];
  author?: { name: string; email: string };
}

export interface CommitRef {
  repo: RepoRef;
  sha: string;
  branch: string;
  message: string;
  /** File snapshot at this commit (path -> content). */
  files: Record<string, string>;
  author: { name: string; email: string };
  at: number;
}

export interface OpenPullRequestInput {
  repo: RepoRef;
  /** Source branch. */
  head: string;
  /** Target branch; defaults to the default branch. */
  base?: string;
  title: string;
  body?: string;
  /** Links the PR back to the work item (recorded on the PR and the work item). */
  workItemId?: string;
  draft?: boolean;
}

export type PullRequestState = 'open' | 'merged' | 'closed';

export interface PullRequest {
  id: string;
  number: number;
  repo: RepoRef;
  head: string;
  base: string;
  title: string;
  body: string;
  url: string;
  state: PullRequestState;
  workItemId?: string;
  createdAt: number;
}

export interface CommentInput {
  repo: RepoRef;
  pullRequestNumber: number;
  body: string;
  author?: string;
}

export interface Comment {
  id: string;
  repo: RepoRef;
  pullRequestNumber: number;
  body: string;
  author: string;
  createdAt: number;
}

export type CheckConclusion = 'success' | 'failure' | 'pending' | 'neutral' | 'skipped';

export interface CheckRun {
  name: string;
  conclusion: CheckConclusion;
  url?: string;
}

export interface GetChecksInput {
  repo: RepoRef;
  /** Either a pull request number or a ref (branch/commit). */
  pullRequestNumber?: number;
  ref?: string;
}

export interface ChecksResult {
  repo: RepoRef;
  ref: string;
  checks: CheckRun[];
  /** True when every check is `success` or `skipped`. */
  green: boolean;
}

export interface MergeInput {
  repo: RepoRef;
  pullRequestNumber: number;
  method?: 'merge' | 'squash' | 'rebase';
}

export interface MergeResult {
  merged: boolean;
  /** Merge commit SHA on the base branch, or `null` when nothing was merged. */
  sha: string | null;
  pullRequest: PullRequest;
}

/**
 * A revert is the *only* way anything other than a merge lands on the default branch: it
 * restores a previously-known tree as a new commit (never a force-push). The merge queue
 * uses it to undo a batch whose merged stack went red (spec `merge-queue` › revert on red).
 */
export interface RevertInput {
  repo: RepoRef;
  /** Commit whose file tree is restored (usually the pre-batch default-branch head). */
  toSha: string;
  message?: string;
  author?: { name: string; email: string };
}

export interface RevertResult {
  repo: RepoRef;
  /** The new revert commit on the default branch. */
  sha: string;
  branch: string;
  revertedTo: string;
}

export interface CodeForge {
  readonly id: string;
  checkout(input: CheckoutInput): Promise<CheckoutResult>;
  createBranch(input: CreateBranchInput): Promise<BranchRef>;
  commit(input: CommitInput): Promise<CommitRef>;
  openPullRequest(input: OpenPullRequestInput): Promise<PullRequest>;
  comment(input: CommentInput): Promise<Comment>;
  getChecks(input: GetChecksInput): Promise<ChecksResult>;
  merge(input: MergeInput): Promise<MergeResult>;
  /** Optional: backends that cannot rewrite the default branch (read-only mirrors) omit it. */
  revert?(input: RevertInput): Promise<RevertResult>;
}
