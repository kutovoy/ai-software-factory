# Design

## Context

`RunWorkflow` executes one run. Gates already resolve as pure policy (`@factory/core`), and ADR-013 made
permission waits workflow-level. Phase 3a composes these into a loop: a work item flows through stages,
each stage is a run, gates pause between stages, and a foreman decides what happens next.

## Goals / Non-Goals

**Goals:**
- One work item = one durable workflow, resumable across days.
- Stage transitions are explicit, recorded, and reversible (`request_changes` sends work back).
- Gates are durable waits with SLA escalation; lights-off is a policy, not a code path.
- Review committee produces findings, never approvals.
- Everything testable with the fake forge + fake harness, no credentials.

**Non-Goals:**
- No real GitHub, no merge queue, no bisecting (3b).
- No scorers/benchmarks (Phase 4).
- No self-improvement (Phase 5).
- No multi-tenant auth.

## Decisions

1. **Work item is a record, not a workflow variable.** Persisted in Postgres with a stable id
   (`wi_<ulid>`), typed (`task|bug|incident|pr_review`), with `source` (forge/slack/cron/manual), `lineage`
   (parent/child), and `stage`. The workflow id is derived from the work item id, so restarts reattach.
2. **Stage graph is compiled, not hardcoded.** The definition's `stages` (ordered) + per-stage `agent`
   produce a DAG. `needs` edges allow fan-out (e.g. two reviewers in parallel). Unknown stages fail validation.
3. **Each stage is a child workflow.** `StageWorkflow` wraps a run + its gate. This keeps history bounded
   and lets a stage be retried/replayed independently.
4. **Foreman is a workflow, not a model.** Deterministic control flow decides the next stage; the foreman
   *agent* is invoked only for judgement calls (triage classification, `request_changes` interpretation),
   and its output is constrained to a schema. This keeps cost and failure modes predictable.
5. **Gate decisions are Temporal Updates** (`submitGateDecision`) with Signal fallback, `await condition`,
   SLA timer that escalates to the inbox and then auto-rejects (lights-on) or auto-approves (lights-off,
   only if `mergePolicy` allows).
6. **Review committee.** `review` stage fans out to N reviewers (≥2 when `reviewers >= 2`), each returns a
   structured findings report; a judge merges them into one advisory verdict. Nothing merges on a verdict.
7. **Forge interface is minimal and async.** `checkout`, `createBranch`, `commit`, `openPullRequest`,
   `comment`, `getChecks`, `merge`. Fake backend keeps an in-memory repo + PR objects and can simulate red
   checks.
8. **Kill switch.** A global `autonomy: enabled|paused` flag; `paused` forces every gate to `human` and
   stops dispatch of new stages. Recorded as an event.

## Risks / Trade-offs

- **Workflow history growth** with long loops. Mitigation: child workflows per stage + `continueAsNew` on
  the work-item workflow after N stages.
- **Gate SLA auto-decisions are dangerous.** Mitigation: auto-approve only when `mergePolicy` allows and
  `benchmarkGateRequired` is satisfied; otherwise auto-reject and escalate.
- **Fan-out reviewer ordering.** Mitigation: judge waits for all reviewer children; partial results are
  recorded as `incomplete`.
- **Fake forge divergence from GitHub.** Mitigation: contract tests shared by both backends in 3b.
