# Tasks

## 1. Forge (`packages/forge`)

- [x] 1.1 `CodeForge` interface: `checkout`, `createBranch`, `commit`, `openPullRequest`, `comment`, `getChecks`, `merge`
- [x] 1.2 `fake.ts` — in-memory repo/PR/checks; deterministic red-check simulation; `protected_branch` enforcement
- [x] 1.3 Contract test suite shared by backends (fake now, github in 3b)
- [x] 1.4 `README.md` with the interface and backend matrix

## 2. Work items (`packages/core` + migration `003`)

- [x] 2.1 `WorkItem` type + Zod schema (`id`, `type`, `source`, `sourceRef`, `title`, `stage`, `parentId`, `factory`, `definitionCommit`)
- [x] 2.2 `003_work_items.sql` — `work_items`, `work_item_events`, `gate_decisions`, `autonomy_state`
- [x] 2.3 Repository functions: create, transition, attach PR, list with filters

## 3. Stage graph (`packages/core`)

- [x] 3.1 Compile `stages` + `needs` into a DAG; detect unknown stages and cycles (`invalid_stage_graph`)
- [x] 3.2 Per-stage config resolution (agent, model/harness, runner, tools) with `spawnableBy` enforcement
- [x] 3.3 Tests for default graph, fan-out, cycle, unknown stage

## 4. Orchestration (`packages/orchestration`)

- [x] 4.1 `FactoryWorkflow` — one per work item; `continueAsNew` after N stages
- [x] 4.2 `StageWorkflow` — child workflow wrapping a run + its gate
- [x] 4.3 Gate activities: `awaitGate` via Update `submitGateDecision` + Signal fallback + SLA timer
- [x] 4.4 Foreman dispatch activity with `spawn_not_allowed` enforcement
- [x] 4.5 Judgement-call activity with schema-constrained output + retry + escalation
- [x] 4.6 Review fan-out + judge activity producing `{verdict, findings[], confidence}`
- [x] 4.7 Autonomy policy evaluation + kill switch signal (`autonomy.paused`)
- [x] 4.8 Tests: stage transition, request_changes loop limit, SLA auto-reject/approve, kill switch, disagreement → `needs_human`

## 5. API (`apps/api`)

- [x] 5.1 `POST /work-items` (manual), `GET /work-items`, `GET /work-items/:id`
- [x] 5.2 `POST /work-items/:id/gates/:stage` — submit gate decision (Update)
- [x] 5.3 `POST /autonomy` — enable/pause with actor + reason
- [x] 5.4 Tests incl. `spawn_not_allowed`, `invalid_stage_graph`, autonomy refusal without benchmark gate

## 6. UI (`apps/web`)

- [x] 6.1 Work items board (stage columns: triage/spec/plan/implement/review/verify/ship) with links to runs
- [x] 6.2 Inbox gains gate approvals (approve/reject/request_changes with feedback)
- [x] 6.3 Work item detail: stage timeline, gate decisions, reviewer findings, PR link
- [x] 6.4 Gates page shows live autonomy state + kill switch (disabled until benchmark gate in Phase 4)

## 7. Tests & wrap-up

- [x] 7.1 E2E: create work item → triage → spec gate approve → implement → review (2 reviewers) → verify → ship (fake forge)
- [x] 7.2 E2E lights-off: same flow with all-agent gates; assert benchmark-gate refusal until overridden
- [x] 7.3 `scripts/smoke.sh` extended with a one-stage loop through the fake forge
- [x] 7.4 STATUS, ADR-014 (work item = durable workflow; foreman deterministic), ADR-015 (advisory review committee)
- [x] 7.5 `openspec validate add-factory-loop` passes
