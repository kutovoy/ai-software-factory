# Tasks

## 1. Routing

- [x] 1.1 Add `routing.classifier` tiers to the schema.
- [x] 1.2 Add deterministic `scoreTask`, `tierForScore`, `chooseRouting`.
- [x] 1.3 Consume routing in `resolveStageConfigs` and `resolveRunDefaults`.
- [x] 1.4 Enable classifier routing in `hello-nextjs`.

## 2. Spend caps

- [x] 2.1 Add `budget` to `factory.yaml`.
- [x] 2.2 Pass per-run/stage caps through workflow/run inputs.
- [x] 2.3 Enforce the cap in the event pump with `budget_exhausted`.
- [x] 2.4 Enforce the factory cap at run/work-item creation.
- [x] 2.5 Add `GET /factories/:factoryId/budget` and OpenAPI.

## 3. Tests

- [x] 3.1 Classifier tests (cheap/standard/deep, env resolution, stage fallback).
- [x] 3.2 Pump budget test (`budget_exhausted`).
- [x] 3.3 Full typecheck/test suite.
- [x] 3.4 Recreate/rerun `hello-nextjs` after the change.
