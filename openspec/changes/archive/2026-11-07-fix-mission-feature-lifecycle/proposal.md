# Proposal

## Why

Live missions exposed two lifecycle bugs:

1. A mission feature ran the factory's whole-app `verify` QA gate even when it was only one
   partial slice (for example, "add package.json"). The first feature could never pass QA
   before the rest of the milestone existed, so the mission escalated.
2. A feature whose work was already satisfied by the integrated forge repository captured an
   empty patch and failed at PR opening (`patch_missing`) instead of completing.

The planner also produced static-only validation contracts for a runnable-site goal, so a
mission could pass while the app's build was still broken.

## What Changes

- Mission feature work items run `implement → review → ship`; `verify` is owned by the
  milestone validation boundary (fresh scrutiny + user-testing after all features merge).
- Mission features may produce an empty implement patch when the integrated branch already
  satisfies them; the work item is marked done with a `work_item.no_changes` event and no PR.
  Regular work items keep the strict `patch_missing` behavior.
- The planner prompt requires an install/build assertion and an e2e assertion when the goal
  asks for runnable software.

## Capabilities

### Modified Capabilities

- `missions`: feature lifecycle, milestone verification ownership, empty-patch handling and
  planner guidance for runnable goals.

## Impact

- Orchestration only; no schema or migration.
- Live verification reruns the full-autonomy `hello-nextjs` mission.
