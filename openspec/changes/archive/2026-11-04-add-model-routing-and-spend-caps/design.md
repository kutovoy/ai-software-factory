# Design

## Context

`routing.yaml` exists in the schema and loader but no runtime code reads it.
`resolveStageConfigs` resolves agent -> agentDefaults -> harness model. Cost is recorded on
runs but no cap is enforced. The runner pump already sees every `usage.updated` event, which
is the natural enforcement point.

## Decisions

### 1. Deterministic classifier

`scoreTask(prompt, stage)` combines a stage base score, prompt length and a small keyword
set (security/migration/architecture/refactor/performance/concurrency/database/auth/encryption
push deep; readme/typo/rename/small/simple/docs/comment pull cheap). `tierForScore` maps
<=2 to cheap, >=7 to deep, otherwise standard. The same input always yields the same tier.

### 2. Opt-in classifier precedence

`routing.classifier.enabled` defaults to false. When true, the tier inference wins over the
agent/default model. When false, `routing.stages[stage]` then `routing.default` are used; if
neither exists, the agent/default model remains. This keeps every existing factory working.

### 3. Budgets are hard caps

- `maxCostUsdPerRun`: passed into `RunInput.maxCostUsd`.
- `maxCostUsdPerStage`: wins over the run cap for that stage.
- `maxCostUsdPerFactory`: checked at work-item/run creation against `sum(runs.cost_usd)`.

The pump accumulates `usage.updated.costUsd`; when it crosses the cap it returns a
`budget_exhausted` failure, which the existing run failure path records as a terminal error.
The factory cap refuses new work with `factory_budget_exhausted` (409).

### 4. Budget status endpoint

`GET /factories/:factoryId/budget` returns the configured caps, recorded spend and whether
the factory cap is exhausted. It is a read-only projection; no new table.

### 5. Routing is resolved where stage configs are built

Work-item creation compiles stage configs with the routing definition and the task prompt;
the resulting `stageGraph` carries the selected model. Chat/run creation resolves defaults
with the same classifier. This keeps routing deterministic per item and visible in the
existing stage graph.

## Risks / Trade-offs

- Keyword routing is coarse; it is intentionally explainable and can be replaced later by a
  learned classifier behind the same interface.
- A factory cap based on recorded spend can lag an in-flight run; the per-run cap bounds
  that run.
- A zero cap is valid and refuses all new work; operators can use it as a kill switch.

## Migration

No schema migration. Definitions without `routing.classifier` or `budget` keep their current
behaviour.
