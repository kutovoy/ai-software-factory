# Proposal

## Why

The factory now caps slop and review load, but model routing ignores risk: a high-risk change can still be
sent to a cheap model, and a low-risk change can consume a deep model. Public API/schema changes are counted
in the review packet but do not stop a gate. The two talks argue for routing by stakes and deterministic
standards checks.

## What Changes

- **Risk-aware routing:** the deterministic classifier takes the work item's risk tier into account; high-risk
  work is routed to the deep tier, while low-risk work keeps the existing score-based routing.
- **Standards guard:** `quality.standards` caps public API and schema changes; the review packet records the
  standard vs actual and a gate resolves `request_changes` when exceeded.
- **Durable economics note:** gate waits already release the runner sandbox (the stage run ends before the
  gate), so no new suspend flag is added; code mode remains harness-dependent and is documented as deferred.

## Capabilities

### Modified Capabilities

- `factory-definition`: `quality.standards` configuration.
- `factory-loop`: standards stop condition and risk-aware routing.
- `web-console`: standards card in the review packet.

## Impact

- Additive schema/config; old factories validate with defaults.
- Orchestration: routing risk input, review packet standards, gate behavior.
- API/Web: routing pass-through, packet standards UI, help.
- Tests: routing, standards evaluation, packet/gate, Playwright.
