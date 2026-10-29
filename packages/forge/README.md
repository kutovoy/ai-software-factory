# @factory/forge — the code-forge boundary

Everything the factory loop does to a repository goes through one interface. The loop never
shells out to `git` and never calls a vendor API directly; a backend implements the interface and
the contract suite proves it behaves like the others.

```ts
interface CodeForge {
  checkout(input: { repo; ref? }): Promise<CheckoutResult>;
  createBranch(input: { repo; name; from? }): Promise<BranchRef>;
  commit(input: { repo; branch; message; files; author? }): Promise<CommitRef>;
  openPullRequest(input: { repo; head; base?; title; body?; workItemId? }): Promise<PullRequest>;
  comment(input: { repo; pullRequestNumber; body }): Promise<Comment>;
  getChecks(input: { repo; pullRequestNumber?; ref? }): Promise<ChecksResult>;
  merge(input: { repo; pullRequestNumber; method? }): Promise<MergeResult>;
}
```

## Backend matrix

| Backend | Status | Transport | Notes |
| --- | --- | --- | --- |
| `fake` | implemented | in-memory | Deterministic; used by tests, demos and the fake-harness loop. |
| `github` | Phase 3b | GitHub App + REST/GraphQL | Must pass the same contract suite unchanged. |

## Invariants

- **Agents never push to the default branch.** `commit` on the default branch fails with
  `protected_branch`, and a branch cannot be created with the default branch's name.
- **Merging is the only write to the default branch**, and only when every check is green
  (`checks_not_green` otherwise). Merging is decided by the orchestrator's merge policy, never by
  a review verdict.
- **`openPullRequest` is idempotent** for the same head branch and work item, so a retried
  activity never opens a second PR.
- **Errors are stable codes** (`ForgeError.code`): `protected_branch`, `not_found`,
  `invalid_state`, `checks_not_green`, `no_commits`.

## The fake backend

`FakeForge` keeps repos, branches, commits, pull requests, comments and checks in memory:

```ts
const forge = new FakeForge();
forge.seedRepo({ owner: 'acme', name: 'api-service' }, { 'README.md': '# api\n' });

await forge.createBranch({ repo, name: 'factory/wi_1' });
await forge.commit({ repo, branch: 'factory/wi_1', message: 'change', files: [...] });
const pr = await forge.openPullRequest({ repo, head: 'factory/wi_1', title: 'Work item wi_1' });
```

Red checks are deterministic: a PR whose title/body contains `[red]` gets failing checks, and
`simulateChecks(repo, prNumber, checks)` sets them explicitly. Commit SHAs are content hashes, so
the same change always produces the same SHA.

## Contract tests

```ts
import { runCodeForgeContractTests } from '@factory/forge/contract';

runCodeForgeContractTests('fake', () => new FakeForge(), { setup, redChecks });
```

The suite covers checkout, branch/commit isolation, protected-branch refusal, idempotent PR
creation, comments, green/red checks, merge and `not_found` cases. A new backend must pass it
without changing the suite.
