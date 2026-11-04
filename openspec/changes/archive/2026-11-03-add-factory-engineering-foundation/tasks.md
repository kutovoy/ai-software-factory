# Tasks

## 1. Validation contract + QA pyramid

- [x] 1.1 Add workflow-safe validation types, schema, builder and evidence parser in `packages/core/src/validation`.
- [x] 1.2 Add optional `validation` block to `factory.yaml` schema; document defaults.
- [x] 1.3 Build and persist the contract at work-item creation; carry it through `FactoryWorkflowInput` and `StageWorkflowInput`.
- [x] 1.4 Add the verify-stage evidence instruction, evidence event and agent-gate enforcement.
- [x] 1.5 Add API `validation` projection to work-item detail and refuse human verify approval while required evidence is missing (when enforced).
- [x] 1.6 Add work-item validation panel and QA-tier display.
- [x] 1.7 Add core/API tests for contract build, evidence parsing, enforcement and null/empty states.

## 2. Agent readiness

- [x] 2.1 Add deterministic readiness types and scanner in `packages/core/src/readiness`.
- [x] 2.2 Add optional `readiness` block to `factory.yaml`; advisory by default, `enforceAutonomy` opt-in.
- [x] 2.3 Add `GET /api/v1/factories/{factoryId}/readiness` and block autonomy when configured.
- [x] 2.4 Add readiness page, nav entry and dashboard card; update help/menu reference.
- [x] 2.5 Add unit/API/Playwright tests for scores, thresholds, evidence and autonomy refusal.

## 3. Outcome metrics

- [x] 3.1 Add human-interaction and permission attribution to metrics queries.
- [x] 3.2 Add `humanInteractionsPerPr`, `autonomyRatio`, `costPerAcceptedChange`, `signalToProductionCycleTime`, `incidentMttHours` and `mergedCodeAgeDays`.
- [x] 3.3 Render the new cards and units on the dashboard; keep null+reason behaviour.
- [x] 3.4 Add metrics unit tests and dashboard E2E assertions.

## 4. Deterministic guard hooks

- [x] 4.1 Add pure guard types and checks in `packages/core/src/guard`.
- [x] 4.2 Add optional `guard` block to `factory.yaml`.
- [x] 4.3 Run guards in `forgeOpenPullRequest` before commit; record `guard.checked`/`guard.failed`.
- [x] 4.4 Add `GET /api/v1/factories/{factoryId}/guard-hooks` and show guard status on readiness.
- [x] 4.5 Add unit/API tests for protected branch, path containment, secrets, size limits and pass/fail events.

## 5. Factory Stack help page

- [x] 5.1 Add `stack` diagram to the help diagram renderer.
- [x] 5.2 Add `concepts/factory-stack` help entry with the 00–06 layers and links.
- [x] 5.3 Link the stack page from the dashboard and concepts; update menu/help tests.

## 6. Documentation and verification

- [x] 6.1 Update `README.md` features, architecture and console navigation.
- [x] 6.2 Update `docs/STATUS.md`, `docs/DECISIONS.md` and `docs/HANDOVER.md`.
- [x] 6.3 Update `research/software-factory-ideas.md` status for items 1–5.
- [x] 6.4 Update `apps/api/openapi.json` and the route contract.
- [x] 6.5 Run `bun run ci`, `openspec validate add-factory-engineering-foundation`, and the new Playwright flows.
