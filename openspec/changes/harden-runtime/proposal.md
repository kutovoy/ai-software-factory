# Proposal

## Why

Six known gaps are open, all of them fixable without credentials: two missing routes that force the console to
infer state, an autonomy path that silently downgrades to human gates, a read model that cannot be repaired,
canary artefacts that leak, an unjailed local runner, and one unexplained test flake.

## What Changes

- **Routes:** `GET /autonomy` (declared policy + live state + last event) and `POST /work-items/:id/cancel`
  (cancels the workflow, records actor/reason). The console stops deriving autonomy from the event log and
  stops cleaning up E2E fixtures by rejecting gates.
- **Automation attestation:** work items created by automations consult the benchmark attestation exactly like
  manual ones — no silent fallback to human gates.
- **Read-model rebuild:** `factory rebuild --from runs/` replays `events.jsonl` into Postgres, idempotently,
  with a dry-run diff. Recovery path for a drifted projection.
- **jsonb hygiene:** stop double-encoding `source_ref`/`input`; a migration normalises existing rows.
- **Canary follow-ups:** GC `runs/canary/<rolloutId>` trees after terminal rollout; rollout metrics as a time
  series (not just the window aggregate); promotion applies to the local checkout via a deploy hook.
- **Local runner jail:** `sandbox-exec` profile for `local-process` — reads allowed, writes confined to the
  workspace + temp, network denied unless the factory grants it.
- **Flake hunt:** loop the canary/improvement suites, name the intermittent failure or prove it gone.

## Capabilities

### New Capabilities
- `read-model`: rebuildable, verifiable projection derived from the canonical event log.

### Modified Capabilities
- `factory-loop`: autonomy read model, work-item cancellation, automation attestation parity.
- `run-lifecycle`: cancel semantics for work-item workflows.
- `runner-protocol`: sandbox profile for the local backend.
- `self-improvement`: canary GC, time-series metrics, promotion hook.

## Impact

- No schema-breaking changes; one normalising migration.
- CI stays credential-free; sandbox-exec is exercised on macOS only and skipped elsewhere.
