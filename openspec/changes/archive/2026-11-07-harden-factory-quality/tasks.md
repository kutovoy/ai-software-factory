# Tasks

## 1. Risk-tiered autonomy

- [x] 1.1 Add `governance.risk` schema: `defaultTier`, `tiers` (`planApproval`, `review`, `merge`) and
  `highRiskPaths`; default to `low` with backward-compatible behavior.
- [x] 1.2 Add `riskTier` + `riskReasons` to `MissionPlan` and `MissionFeaturePlan`; derive from explicit tier,
  high-risk path globs, change size and touched areas.
- [x] 1.3 Pass risk tier through `FactoryWorkflowInput`/mission feature work item `sourceRef`; do not add a DB
  migration unless indexing requires it.
- [x] 1.4 Restrict mission plan auto-approval to `low` risk (plus autonomy enabled/unpaused, `autonomyLevel:
  full`, benchmark gate satisfied); record the tier and reasons in `mission.plan.approved`.
- [x] 1.5 For `high` risk, force human review and human ship gates; never auto-merge. For `medium`, require a
  human plan gate and allow agent review + `auto_on_green`.
- [x] 1.6 Tests: schema defaults, risk derivation, auto-approval allowed/denied, high-risk gate/merge.
- [x] 1.7 Update `docs/ARCHITECTURE.md`, `docs/DECISIONS.md` (ADR), help, README if user-visible.

## 2. Architecture and maintainability assertions

- [x] 2.1 Add `architecture` and `maintainability` to `VALIDATION_TIERS` and all zod mirrors.
- [x] 2.2 Add built-in check templates for dependency direction/cycles, public API stability, duplication,
  complexity, churn/rework, diff size and new dependencies; use repo scripts when present.
- [x] 2.3 Allow optional `metrics`/thresholds on validation evidence; surface them in the validation panel.
- [x] 2.4 Planner: require at least one architecture and one maintainability assertion for medium/high-risk
  runnable goals; keep small/low-risk goals lightweight.
- [x] 2.5 Verify gate: required architecture/maintainability evidence must be present; missing evidence blocks.
- [x] 2.6 Tests: contract schema, evaluation, planner, verify-gate refusal, UI rendering.
- [x] 2.7 Update help/status docs.

## 3. Planning artifacts

- [x] 3.1 Add optional `productReview`, `architecture`, `programDesign`, `verticalSlices` to `MissionPlan`
  schema/types; old plans remain valid.
- [x] 3.2 Extend the OpenAI planner prompt and deterministic planner to fill the artifacts for non-trivial
  goals; keep small changes brief.
- [x] 3.3 Mission Control plan card: render product review, architecture, program design and vertical slices
  with honest empty states.
- [x] 3.4 Plan gate/Inbox review surface shows the artifacts before approval.
- [x] 3.5 Tests: schema, planner normalization/validation, web E2E.
- [x] 3.6 Update help and docs.

## 4. Vertical slices

- [x] 4.1 Add `verticalSlice` and `kind: 'slice' | 'enabler'` to `MissionFeaturePlan`; validate at least one
  slice per plan and require enablers to state what later slice verifies them.
- [x] 4.2 Planner prompt: prefer end-to-end slices; group scaffolding into the first runnable slice; avoid
  horizontal “add package.json” features.
- [x] 4.3 Mission Control shows slice/enabler and the checks.
- [x] 4.4 Add a `hello-nextjs`-style regression plan test: scaffolding + page + test grouped as a runnable
  slice rather than four horizontal features.
- [x] 4.5 Update help/docs.

## 5. Review packet and human review

- [x] 5.1 Add `review.packet` work-item event type and deterministic packet payload (risk tier, intent, plan
  ref, changed files, diff stats, assertions/evidence, architecture impact, open questions, checklist).
- [x] 5.2 Generate the packet after review/verify evidence is available; store it as an event/artifact.
- [x] 5.3 Work-item detail and Inbox render a compact review packet; full diff remains linked.
- [x] 5.4 High-risk work items require a human review gate before ship; agent review is triage.
- [x] 5.5 Low-risk items may auto-merge when the verification oracle is cheap and reliable; medium uses agent
  review + `auto_on_green` with optional human sampling.
- [x] 5.6 Tests: packet generation, high-risk human gate, low-risk auto path, UI.
- [x] 5.7 Update help/status/docs.

## 6. Verification and docs

- [x] 6.1 `bun run ci`, `openspec validate --all`, `bash scripts/smoke.sh`.
- [x] 6.2 Playwright: plan artifacts, review packet, high-risk gate, low-risk auto path.
- [x] 6.3 Live check: one low-risk full-autonomy mission and one high-risk human-gated mission on
  `hello-nextjs`.
- [x] 6.4 Update `docs/STATUS.md`, `docs/HANDOVER.md`, `docs/ROADMAP.md`, `docs/SOFTWARE_FACTORY_WEAKNESSES.md`,
  `apps/web/src/lib/help.ts`, `README.md` What's new if user-visible.
- [x] 6.5 Archive the change.
