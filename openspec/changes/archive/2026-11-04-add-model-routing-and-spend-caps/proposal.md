# Proposal

## Why

`routing.yaml` is validated but never consumed at runtime, so every stage uses the model
declared by its agent. There is no spend cap: cost is visible after the fact but a runaway
run can keep spending. Roadmap item 7 asks for classifier-based routing and per-run/factory/
stage budgets with alerts.

## What Changes

- Add an opt-in `routing.classifier` block with `cheap`, `standard` and `deep` tiers.
- Add a deterministic, explainable classifier over the task prompt + stage. It selects a
  tier; the tier's inference wins over the agent/default model when enabled.
- Consume `routing.yaml` at runtime in stage-config resolution and run defaults.
- Add a `budget` block to `factory.yaml`: `maxCostUsdPerRun`, `maxCostUsdPerStage`,
  `maxCostUsdPerFactory`.
- Enforce per-run/stage caps in the event pump (`budget_exhausted`) and the factory cap at
  work-item/run creation.
- Expose `GET /factories/:factoryId/budget` with configured caps, recorded spend and
  exhaustion state.

## Capabilities

### New Capabilities
- None.

### Modified Capabilities
- `factory-definition`: optional `routing.classifier` and `budget`.
- `measurement`: spend caps and budget status.
- `run-lifecycle`: a run stops with `budget_exhausted` when its cost crosses the cap.

## Impact

- `packages/core/src/{schema/routing,schema/factory,routing/classify,stage-graph/resolve}.ts`
- `packages/orchestration/src/{types,pump,activities/harness,workflows/stage,workflows/factory}.ts`
- `apps/api/src/{runs,work-items,app,errors}.ts`, `apps/api/openapi.json`
- `factories/hello-nextjs/{routing.yaml,factory.yaml}`
- Tests: routing classifier, pump budget.

## Non-goals

- No LLM-based router; the classifier is deterministic and auditable.
- No billing integration; cost is the provider-reported `costUsd` already stored on runs.
- No automatic model fallback on provider failure in this change.
