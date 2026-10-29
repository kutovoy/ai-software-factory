# Tasks

## 1. Schema (`packages/core`)

- [ ] 1.1 `improvement` block in `factory.yaml`: `authority`, `canaryPercent`, `rollbackThreshold`, `observationWindowHours`, `maxProbes`
- [ ] 1.2 Validation: enum, canary parameter requirements, default `propose_only`, resolved-config reporting
- [ ] 1.3 Update `factories/example` + `example-lights-off` (propose_only / canary) and canonical snapshots
- [ ] 1.4 CLI: `factory validate` reports the resolved improvement authority

## 2. Persistence (`packages/core`)

- [ ] 2.1 `007_improvement.sql`: `improvement_runs`, `proposals`, `proposal_edits`, `probes`, `lessons`, `canary_rollouts`
- [ ] 2.2 Repository: create proposal, record edit/probe, rank by impact, lesson CRUD, canary state

## 3. Improvement engine (`packages/evals/improve`)

- [ ] 3.1 Eligibility: min scored runs, calibrated judges, authority from definition
- [ ] 3.2 Observer: scored corpus → invariant + domain edits (file-scoped), evidence + impact
- [ ] 3.3 Dedupe/cluster by files + failure signature; ranked list
- [ ] 3.4 Contrastive probe: candidate vs baseline on the same work item, matched inputs
- [ ] 3.5 Compose winners → candidate definition + diff; record rejected edits
- [ ] 3.6 Blast-radius guard: `edit_out_of_scope` for gates/mergePolicy/runners/other paths
- [ ] 3.7 Experience library: per-factory `INDEX.md`/`EXPERIENCE.md` append + opt-in promotion record
- [ ] 3.8 Unit tests: clustering, ranking, scope guard, compose, no-signal path

## 4. Orchestration

- [ ] 4.1 `ImprovementWorkflow` (scheduled/on-demand): eligibility → observe → dedupe → probe → compose → decide
- [ ] 4.2 Decision by authority: `propose_only` (PR), `auto_merge_on_benchmark` (benchmark non-regression then merge, else PR)
- [ ] 4.3 `CanaryWorkflow`: publish candidate, route by hash, observe window, promote/rollback, manual rollback
- [ ] 4.4 Events: `improvement.started/proposal.created/probe.completed/candidate.published/canary.rolled_back`
- [ ] 4.5 Tests: propose-only PR, auto-merge refusal without benchmark, canary promote, canary auto-rollback, manual rollback

## 5. API (`apps/api`)

- [ ] 5.1 `GET /factories/:name/improvement` (authority, eligibility, last run)
- [ ] 5.2 `GET /proposals`, `GET /proposals/:id` (diff, evidence, probes, ranking)
- [ ] 5.3 `POST /proposals/:id/decision` (`accept|reject` with reason) and `POST /proposals/:id/apply` (per authority)
- [ ] 5.4 `GET /lessons`, `POST /lessons/:id/promote`
- [ ] 5.5 `POST /factories/:name/improvement/run`, `POST /canary/rollback`
- [ ] 5.6 Tests: scope rejection, authority routing, canary rollback, lesson isolation

## 6. UI (`apps/web`)

- [ ] 6.1 Self-improvement page: authority selector (writes definition change with diff + confirm), eligibility
- [ ] 6.2 Ranked proposals: impact, evidence, diff viewer, probe results, accept/reject
- [ ] 6.3 Lessons library: per-factory list, confidence, promote-to-shared action
- [ ] 6.4 Canary panel: candidate version, traffic split, observation window, rollback button, history

## 7. Tests & wrap-up

- [ ] 7.1 Integration: scored corpus → proposal → probe → candidate → PR (fake forge)
- [ ] 7.2 E2E: proposals page → accept → PR/merge per authority; canary rollback
- [ ] 7.3 Smoke: one improvement run producing a proposal + lesson
- [ ] 7.4 STATUS, ADR-020 (authority is a definition field), ADR-021 (canary routing by deterministic hash)
- [ ] 7.5 `openspec validate add-self-improvement`
