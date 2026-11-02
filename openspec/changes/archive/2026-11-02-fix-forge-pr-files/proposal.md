# Proposal

## Why

`forgeOpenPullRequest` committed a single `changes/<workItemId>.patch` file instead of applying the
implement patch. Forgejo PRs therefore contained the diff text (plus the seeded README/probe files),
not the generated web code. QA passed because it tested the runner workspace, not the PR branch.

## What Changes

- Apply the implement run's `patch.diff` to the base branch snapshot before committing.
- Commit the resulting `FileChange[]` (added/modified/deleted files), not the `.patch` artifact.
- Fail closed with `patch_missing` when the patch is absent/empty; `patch_apply_failed` when it does
  not apply.
- Add unit and integration tests proving the PR branch contains the actual files.

## Capabilities

### Modified Capabilities
- `forge`: pull requests contain the applied file changes.

## Impact

- `packages/orchestration` only; binary patches are rejected (forge file API is text-only).
