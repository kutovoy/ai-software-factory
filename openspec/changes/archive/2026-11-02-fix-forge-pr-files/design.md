# Design

## Decisions

1. **Apply, don't archive.** `forgeOpenPullRequest` checks out the new branch, applies `patch.diff` to
   a temp copy of the base snapshot with `git apply`, and commits the resulting files.
2. **Fail closed.** A missing/empty patch fails with `patch_missing`; an unapplicable patch fails with
   `patch_apply_failed`; binary diffs fail with `patch_binary_unsupported`.
3. **No `.patch` artifact.** The forge repo contains the web code, not the diff text.
4. **QA remains workspace-based**, but a dedicated integration test asserts the PR branch files; the
   forge commit is now the same applied patch QA tested.
