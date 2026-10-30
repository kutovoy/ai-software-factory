# Design

## Decisions

1. **Autonomy read model.** `autonomy_state` already exists; add a read function returning
   `{declared, enabled, paused, actor, reason, updatedAt, lastEvent}`. The Gates page reads it directly instead
   of scanning work-item events.
2. **Cancel is cooperative and idempotent.** Record `cancel_requested_at` + actor/reason, Signal
   `cancelWorkItem`, let `FactoryWorkflow` cancel the in-flight stage child and end `cancelled`. Repeat calls
   are no-ops returning the same state.
3. **Rebuild is replay, not repair.** The canonical `events.jsonl` is the source of truth; the rebuild reads it
   in `(runId, seq)` order, upserts events/runs/steps idempotently, and reports a diff (rows missing, extra,
   divergent). `--dry-run` reports without writing. Never deletes rows it cannot explain; flags them.
4. **jsonb:** bind objects as JSON strings exactly once at the repository boundary; migration rewrites
   double-encoded values via `jsonb_typeof` detection.
5. **Canary GC** runs on rollout terminal state, keeps the last N trees (configurable), and refuses to delete
   the tree referenced by an in-flight rollout.
6. **Time series** is a derived query over `scores`/`runs` bucketed by hour for the rollout window; no new
   table.
7. **Promotion hook** writes the promoted definition to a staging path and invokes an optional
   `deployHook` command; absent a hook it records `promotion_pending_deploy` instead of pretending.
8. **sandbox-exec** (per <https://alejandromp.com/development/blog/sandboxing-an-ai-harness-on-macos>):
   generated SBPL profile — `(deny default)`, allow read of system paths + workspace, allow write only to the
   workspace, `/private/tmp`, and the run dir, deny `network*` unless granted. Linux/other platforms fall back
   to the current behaviour and say so in the event log.
9. **Flake hunt** is a looped run (50×) over the canary/improvement suites with a failure signature recorded;
   if unreproduced, the STATUS note is replaced with the evidence rather than left as folklore.

## Risks

- sandbox-exec is deprecated by Apple but still functional; keep it behind a flag (`RUNNER_SANDBOX=exec`) so a
  future replacement does not break runs.
- Rebuild must not resurrect deleted runs — it only upserts what the JSONL contains and reports the rest.
