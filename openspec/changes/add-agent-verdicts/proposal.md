# Proposal

## Why

Agent gates currently approve whenever the stage run ends `ok` (`packages/orchestration/src/workflows/stage.ts`).
A reviewer agent that writes “FAIL” in its summary still passes the gate, so lights-off runs can ship changes the
agent explicitly rejected. The gate needs a structured verdict channel.

## What Changes

- A verdict contract: the stage prompt asks agent-gated stages to end with a fenced JSON block
  `{"verdict":"approve|request_changes|reject","summary":"...","findings":[...]}`.
- A parser in `packages/core` reads the last structured block, falls back to explicit textual signals
  (`VERDICT: FAIL`, `FAIL`, `REQUEST_CHANGES`), and reports its source.
- Agent gates map the verdict to `approve`, `request_changes` or `reject`; `request_changes` feeds the existing
  loop/escalation path in `factory.ts`.
- A factory-level `agentVerdict: advisory | required` switch: advisory keeps today’s behaviour when no verdict is
  found; required turns a missing verdict into `request_changes`.
- Gate decisions persist the parsed verdict (`gate_decisions.verdict`) and expose it in the API and console.

## Capabilities

### New Capabilities
- `agent-verdicts`: structured, auditable gate verdicts from agent stages.

## Impact

- Migration 015 adds `gate_decisions.verdict`.
- Schema gains `agentVerdict`; `hello-nextjs` opts into `required`.
- No new routes; the existing gate decision payload grows.
