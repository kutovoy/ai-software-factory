# Tasks

## 1. Slop budgets

- [x] 1.1 Add `quality.slopBudget` schema with per-risk-tier defaults and a resolver.
- [x] 1.2 Add pure patch metrics (changed files, diff lines, new dependencies, high-risk paths) and budget
  evaluation in core.
- [x] 1.3 Measure slop after implement and record `slop.measured` / `slop.budget_exceeded`.
- [x] 1.4 Agent review gates resolve `request_changes` on overage; human gates show the waiver path.
- [x] 1.5 Tests: schema defaults, patch parsing, budget evaluation, gate behavior.

## 2. Review packet v2 and proof

- [x] 2.1 Extend `ReviewPacket` with budget, blast radius, proof, read-first, decisions, roles and
  comprehension.
- [x] 2.2 Collect proof artifacts from run artifacts and bind them to commit/hash.
- [x] 2.3 Add `review.explainer` event/artifact for the optional model-written summary/HTML page.
- [x] 2.4 Render the packet on work-item detail and Inbox with a proof gallery and read-first list.
- [x] 2.5 Tests: packet fields, proof binding, UI E2E.

## 3. Visual alignment

- [x] 3.1 Vendor a project-local `show-me` skill and document it.
- [x] 3.2 Mission plans reference mockup/diagram artifacts; medium/high UI plans require one.
- [x] 3.3 Render/link visual artifacts in Mission Control.
- [x] 3.4 Tests: schema, planner, UI.

## 4. Context pack

- [x] 4.1 Add a deterministic context-pack builder (ADRs, constraints, prior PRs/failures, test standards,
  relevant files).
- [x] 4.2 Pass the pack into feature/work-item stage prompts and reference it from the packet.
- [x] 4.3 Store the pack as a run artifact and show its sources in the UI.
- [x] 4.4 Tests: builder determinism, prompt inclusion.

## 5. Anti-slop toolpack and plan depth

- [x] 5.1 Vendor an anti-slop skill and deterministic rules; infer an `anti-slop` script as a
  maintainability check.
- [x] 5.2 Add `planDepth`/`expectedPain`/`leverage` to missions and work items; use them to right-size
  artifacts.
- [x] 5.3 Tests: anti-slop violation fails verify; light plan skips full artifacts.
- [x] 5.4 Update help/docs/README/STATUS/ROADMAP/ADR.

## 6. Verification

- [x] 6.1 `bun run ci`, `openspec validate --all`, `bash scripts/smoke.sh`, Playwright.
- [x] 6.2 Re-run the hello-world factory cycle after the stage.
