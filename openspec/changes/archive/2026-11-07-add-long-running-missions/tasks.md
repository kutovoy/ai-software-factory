# Tasks

## 1. Core mission model

- [x] 1.1 Add mission types, plan/validation schemas, IDs and pure scheduler helpers.
- [x] 1.2 Add `024_missions.sql` with missions, milestones, features, checkpoints, events, gates,
  validations, work-item/run links and indexes.
- [x] 1.3 Add mission repository functions: create/get/list/update, plan persistence, checkpoints, events,
  gates, validations and budget spend.
- [x] 1.4 Unit tests for plan validation, dependency order, progress and status transitions.

## 2. Mission planning and API

- [x] 2.1 Add mission planner boundary with a deterministic test planner and a real planner path.
- [x] 2.2 Add factory-scoped mission API: create/list/detail, plan gate, pause/resume/cancel, feature retry.
- [x] 2.3 Update OpenAPI and the contract test.
- [x] 2.4 API tests for ownership, plan approval, invalid plans and mission state.

## 3. Mission workflow

- [x] 3.1 Add `MissionWorkflow` with plan approval, feature child workflows, checkpoints, pause/resume/cancel
  and continue-as-new.
- [x] 3.2 Add mission activities: plan, create feature work item, checkpoint, status, budget, validation
  preparation and fix-feature planning.
- [x] 3.3 Add a mission work-item builder on the core loader/compiler (the API work-item path remains
  separate; unifying them is a follow-up, not required for the mission MVP).
- [x] 3.4 Integration test with a fake planner/validator and a 2-feature mission.
- [x] 3.5 Test validation failure → fix feature → revalidation; budget exhaustion; pause/cancel.

## 4. Validation loop

- [x] 4.1 Add mission validation contract and evidence evaluation.
- [x] 4.2 Run fresh scrutiny and user-testing validators at milestone boundaries.
- [x] 4.3 Create fix features from findings; cap validation rounds and block on exhaustion.
- [x] 4.4 Record validation evidence and artifacts.

## 5. Mission Control UI

- [x] 5.1 Add Missions nav entry, list page and create mission form.
- [x] 5.2 Add mission detail: plan, milestones/features, timeline, validations, budget, work-item links.
- [x] 5.3 Add plan approval, pause/resume/cancel/replan controls and inbox integration.
- [x] 5.4 Add help entry, menu reference and quick-start update.
- [x] 5.5 Playwright E2E: create → approve plan → progress → pause/resume/cancel.

## 6. Verification and docs

- [x] 6.1 `bun run ci` and `openspec validate`.
- [x] 6.2 Live `hello-nextjs` mission with plan approval and milestone validation (plan gate, feature
  work item, scrutiny + user-testing validation, PR merge, mission done).
- [x] 6.3 Update STATUS, ROADMAP, HANDOVER, GLOSSARY, ARCHITECTURE and README "What's new".
- [x] 6.4 ADR for the mission model and durable workflow.
