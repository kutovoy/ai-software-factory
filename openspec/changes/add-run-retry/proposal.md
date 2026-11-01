# Proposal

## Why

The failure panel tells the operator to "fix the cause, then re-run" but there is no retry action. Re-running the
same run id is also the wrong model: the read model dedupes `(runId, seq)` and already holds one terminal event,
and Temporal replay re-executes completed activities, repeating side effects.

## What Changes

- **`POST /api/v1/runs/:id/retry`** creates a *new* run from the stored input (prompt, factory, harness, model,
  runner, repo), with a fresh run id, proxy token and runner lease. It records `retryOf` on the new run and
  returns it; double submits are deduped for a short window.
- **Eligibility:** `chat` runs in `error` or `cancelled`; `running`/`ok` and factory stage runs are refused
  (`run_not_retryable`) — stage retries belong to the work item/foreman.
- **Lineage:** the new run shows "retried from <id>"; the old run shows "retried as <id>" when a child exists.
- **UI:** a "Retry as new run" button on eligible run pages, disabled while in flight, navigating to the new run;
  the failure-panel copy references the button instead of promising a manual re-run.

## Capabilities

### Modified Capabilities
- `run-lifecycle`: retry-as-new-run with lineage and idempotency.
- `web-console`: retry action and truthful failure copy.

## Impact

- No schema change (`retryOf` lives in the run input JSON); one endpoint, one proxy route, one button.
