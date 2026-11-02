# Proposal

## Why

A required agent verdict reads the stage run's summary. The opencode adapter emitted
`run.completed` without the final assistant text, so the first Playwright-QA readiness run
escalated at triage even though the agent had written a valid fenced JSON verdict.

## What Changes

- Track the last assistant message in the opencode event mapper.
- Include it as `run.completed.summary` for successful runs.
- Update the adapter unit and contract tests.

## Capabilities

### Modified Capabilities
- `agent-verdicts`: the run summary carries the agent's final message.

## Impact

- `packages/adapters` only; no schema, API or workflow change.
