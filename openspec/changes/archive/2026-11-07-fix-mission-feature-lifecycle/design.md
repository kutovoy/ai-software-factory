# Design

## Decisions

1. **Milestone validation owns verify.** Feature work items skip the `verify` stage and run
   implement/review/ship. This lets incremental features merge without failing a whole-app QA
   gate before the milestone exists. Milestone scrutiny and user-testing still run the verify
   agent and mission contract after all features merge.
2. **Empty patch is valid for a mission feature.** `forgeOpenPullRequest` accepts
   `allowEmptyPatch` only from mission feature workflows. If the patch is empty it returns
   `skipped`; `FactoryWorkflow` records `work_item.no_changes` and marks the item done. A
   normal work item still fails `patch_missing`.
3. **Planner must require runnable evidence.** The planner prompt tells the model to include
   an install/build assertion and a browser/e2e assertion for runnable-software goals, so a
   static-only contract cannot let a broken build pass.

## Risks

- A mission feature with no patch is not reviewed; milestone validation remains the backstop.
- The planner can still produce weak contracts; humans can request plan changes, and the
  benchmark/autonomy gate controls auto-approval.
