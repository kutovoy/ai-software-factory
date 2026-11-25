# Tasks

## 1. Review capacity and comprehension

- [x] 1.1 Add `quality.reviewCapacity` schema/resolver with defaults.
- [x] 1.2 Add a deterministic review-capacity projection from pending gates and review packets.
- [x] 1.3 Mission auto-approval refuses when capacity is saturated; autonomy enable requires an override.
- [x] 1.4 `GET /autonomy` returns `reviewCapacity` and `comprehension`.
- [x] 1.5 Gates page shows capacity/comprehension cards.
- [x] 1.6 Tests: resolver, projection, auto-approval refusal, UI.

## 2. Unified decision trail

- [x] 2.1 PR body includes plan/risk/context/review-packet refs and assertion summary.
- [x] 2.2 Work-item detail shows a chronological decision trail.
- [x] 2.3 Tests: PR body, UI.

## 3. Experiments metadata

- [x] 3.1 Add `experiments` factory schema and mission plan `experiment`.
- [x] 3.2 Mission Control shows the experiment/rollout/cleanup.
- [x] 3.3 Tests: schema, planner/API, UI.

## 4. Longitudinal quality

- [x] 4.1 Add deterministic longitudinal metrics/evaluation in `packages/evals`.
- [x] 4.2 Tests: degradation detected, improvement accepted, missing metrics honest.
- [x] 4.3 Document how it gates autonomy.

## 5. Lessons in context packs

- [x] 5.1 Include approved factory lessons in the context pack (bounded, provenance).
- [x] 5.2 Tests: lessons included/excluded, bounded.

## 6. Verification

- [x] 6.1 `bun run ci`, `openspec validate --all`, `bash scripts/smoke.sh`, Playwright.
- [x] 6.2 Re-run the hello-world factory cycle after the stage.
