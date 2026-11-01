# Proposal

## Why

A finished run still renders a disabled "Cancel run" button, and an escalated work item has no way back —
the stage run refuses retry (`run_not_retryable`, by design) and the work item offers no retry, so the operator
is stuck.

## What Changes

- **Cancel only when meaningful:** the control renders only for `pending`/`running`/`cancelling`; terminal runs
  show their end state instead of a dead button.
- **Work-item retry:** `POST /api/v1/work-items/:id/retry` re-opens an `escalated`, `failed` or `blocked` item,
  clears cancellation state, records `work_item.retried` (actor + reason) and dispatches the current stage again
  under a new attempt workflow id. `active`/`done` items are refused with `work_item_not_retryable`.
- **Stage run page:** factory stage runs show "Retry the work item" (link) instead of a per-run retry, matching
  the ownership rule; the work-item page carries the actual retry control.
- **Idempotency:** a double submit within the dedupe window returns the same dispatch; the UI disables while in
  flight.

## Capabilities

### Modified Capabilities
- `factory-loop`: work-item retry with audit and a fresh attempt.
- `web-console`: contextual actions (cancel only when live; retry where it belongs).

## Impact

- One API endpoint, one repository transition, two UI controls; no schema change.
