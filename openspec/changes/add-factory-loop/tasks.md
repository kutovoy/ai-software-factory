# Tasks

## 1. Forge (`packages/forge`)

- [ ] 1.1 `CodeForge` interface: `checkout`, `createBranch`, `commit`, `openPullRequest`, `comment`, `getChecks`, `merge`
- [ ] 1.2 `fake.ts` — in-memory repo/PR/checks; deterministic red-check simulation; `protected_branch` enforcement
- [ ] 1.3 Contract test suite shared by backends (fake now, github in 3b)
- [ ] 1.4 `README.md` with the interface and backend matrix

## 2. Work items (`packages/core` + migration `003`)

- [ ] 2.1 `WorkItem` type + Zod schema (`id`, `type`, `source`, `sourceRef`, `title`, `stage`, `parentId`, `factory`, `definitionCommit`)
- [ ] 2.2 `003_work_items.sql` — `work_items`, `work_item_events`, `gate_decisions`, `autonomy_state`
- [ ] 2.3 Repository functions: create, transition, attach PR, list with filters

## 3. Stage graph (`packages/core`)

- [ ] 3.1 Compile `stages` + `needs` into a DAG; detect unknown stages and cycles (`invalid_stage_graph`)
- [ ] 3.2 Per-stage config resolution (agent, model/harness, runner, tools) with `spawnableBy` enforcement
- [ ] 3.3 Tests for default graph, fan-out, cycle, unknown stage

## 4. Orchestration (`packages/orchestration`)

- [ ] 4.1 `FactoryWorkflow` — one per work item; `continueAsNew` after N stages
- [ ] 4.2 `StageWorkflow` — child workflow wrapping a run + its gate
- [ ] 4.3 Gate activities: `awaitGate` via Update `submitGateDecision` + Signal fallback + SLA timer
- [ ] 4.4 Foreman dispatch activity with `spawn_not_allowed` enforcement
- [ ] 4.5 Judgement-call activity with schema-constrained output + retry + escalation
- [ ] 4.6 Review fan-out + judge activity producing `{verdict, findings[], confidence}`
- [ ] 4.7 Autonomy policy evaluation + kill switch signal (`autonomy.paused`)
- [ ] 4.8 Tests: stage transition, request_changes loop limit, SLA auto-reject/approve, kill switch, disagreement → `needs_human`

## 5. API (`apps/api`)

- [ ] 5.1 `POST /work-items` (manual), `GET /work-items`, `GET /work-items/:id`
- [ ] 5.2 `POST /work-items/:id/gates/:stage` — submit gate decision (Update)
- [ ] 5.3 `POST /autonomy` — enable/pause with actor + reason
- [ ] 5.4 Tests incl. `spawn_not_allowed`, `invalid_stage_graph`, autonomy refusal without benchmark gate

## 6. UI (`apps/web`)

- [ ] 6.1 Work items board (stage columns: triage/spec/plan/implement/review/verify/ship) with links to runs
- [ ] 6.2 Inbox gains gate approvals (approve/reject/request_changes with feedback)
- [ ] 6.3 Work item detail: stage timeline, gate decisions, reviewer findings, PR link
- [ ] 6.4 Gates page shows live autonomy state + kill switch (disabled until benchmark gate in Phase 4)

## 7. Tests & wrap-up

- [ ] 7.1 E2E: create work item → triage → spec gate approve → implement → review (2 reviewers) → verify → ship (fake forge)
- [ ] 7.2 E2E lights-off: same flow with all-agent gates; assert benchmark-gate refusal until overridden
- [ ] 7.3 `scripts/smoke.sh` extended with a one-stage loop through the fake forge
- [ ] 7.4 STATUS, ADR-014 (work item = durable workflow; foreman deterministic), ADR-015 (advisory review committee)
- [ ] 7.5 `openspec validate add-factory-loop` passes
