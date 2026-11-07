# Proposal

## Why

Missions currently always wait for a human plan approval. That is correct for lights-on factories, but it
means a `autonomyLevel: full` factory with autonomy enabled (and a benchmark attestation or an audited
override) still needs a human touch before any feature runs. The lights-off verification path should be
fully unattended end to end.

## What Changes

- Add a mission plan auto-approval decision when the factory is enabled for autonomy, not paused, has
  `autonomyLevel: full`, and the benchmark gate is satisfied by an attestation or an audited override.
- Record the auto-approval on the same mission gate row and emit the normal `mission.plan.approved` event
  with an explicit automatic actor/reason, so the audit trail still explains who approved the plan.
- Keep the human plan gate for every other factory; lights-on behavior is unchanged.

## Capabilities

### Modified Capabilities

- `missions`: plan approval may be automatic under the full-autonomy + benchmark gate condition.

## Impact

- Orchestration activity/workflow change only; no schema or migration.
- Live verification: a fresh `hello-nextjs` factory with autonomy enabled and an audited override runs a
  mission with no human decisions.
