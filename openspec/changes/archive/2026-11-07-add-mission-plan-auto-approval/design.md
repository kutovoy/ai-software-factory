# Design

## Context

The mission workflow creates a `mission_gates` plan row and waits on a Temporal Update/Signal. The
existing factory loop already treats `autonomy.enabled + autonomyLevel full + benchmark gate satisfied`
as permission to proceed without human gates. Mission plan approval should reuse that policy instead of
inventing a second autonomy mechanism.

## Decisions

1. **Auto-approve only for full autonomy with the benchmark gate satisfied.** The condition is:
   - autonomy state exists and is enabled, not paused;
   - the factory definition has `governance.autonomyLevel: full`;
   - the benchmark gate is either not required or is satisfied by the existing audited override.
2. **Use the same gate row.** The activity calls `decideMissionGate` with `approve`; the workflow then
   uses the normal approved-plan path. The `mission.plan.approved` event records `actor: "autonomy"` and
   a reason that includes the autonomy level and gate evidence.
3. **Fail closed.** A missing definition, missing autonomy state, paused autonomy, non-full level, or
   unsatisfied benchmark gate leaves the human wait in place.

## Risks / Trade-offs

- Auto-approval could let a bad plan run unattended. It is restricted to the same full-autonomy policy that
  already removes human gates elsewhere, and the gate row/event retain the audit evidence.
- A planner can still be wrong; milestone validators and fix features remain the quality backstop.

## Migration Plan

No data migration. Existing missions keep their current gate decisions; only new plans are eligible.
