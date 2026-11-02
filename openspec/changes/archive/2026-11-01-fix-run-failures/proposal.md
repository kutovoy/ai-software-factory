# Proposal

## Why

A real chat run failed with "Activity task failed". The actual cause was `RunnerError: docker_unavailable` —
the worker image never installed the `docker` CLI, so it could not lease a runner. The UI showed only the
Temporal wrapper message, and the run page's 4-column meta grid let a 40-char SHA overlap the harness/model cell.

## What Changes

- **Worker image:** install `docker-ce-cli` (multi-arch) so the docker runner can lease sibling containers;
  `docker version` must succeed inside the worker.
- **Failure propagation:** a `describeFailure()` helper walks the Temporal cause chain and records code + message
  (e.g. `docker_unavailable: docker CLI/server is not available`) in the run summary, error and the
  `workflow-error` step, instead of the wrapper text.
- **Run page:** meta grid no longer overlaps (short SHA with full value in the title/copy, `min-w-0`); a dedicated
  failure panel shows the error, code, failed steps, workflow id and a Temporal UI link, with remediation hints
  for known codes (`docker_unavailable`, `model_unresolved`, `runner_unavailable`, `permission_timeout`).

## Capabilities

### Modified Capabilities
- `run-lifecycle`: failures carry a cause chain, not the Temporal wrapper.
- `web-console`: run page layout and a failure panel.

## Impact

- Worker image grows by the Docker CLI (~30 MB); build needs network.
- No schema change; `error` keeps its type, richer content.
