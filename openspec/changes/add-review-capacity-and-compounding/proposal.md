# Proposal

## Why

The factory can generate more changes than a team can review. The `12 Rules` talk calls this back pressure:
review and comprehension are the scarce resources. We now cap individual changes with slop budgets, but the
factory still has no factory-level attention budget, no comprehension signal, and no single decision trail
from plan to PR. It also cannot learn from prior sessions beyond ad-hoc experience files, and it has no
longitudinal quality measure.

## What Changes

- **Review capacity:** `quality.reviewCapacity` caps open review gates, unread diff lines, oldest gate age and
  review hours per week. A saturated factory cannot auto-approve a mission plan or enable full autonomy
  without an explicit override.
- **Comprehension projection:** the autonomy read model reports unread diff volume, items without human
  review, modules without human touch and review coverage.
- **Unified decision trail:** PR bodies carry plan/risk/context/review-packet links; work-item detail shows a
  single trail from plan through gates, review, PR, merge and incidents.
- **Experiments:** factories declare an optional experiment provider/flag prefix, and mission plans carry an
  experiment/rollout/cleanup record. Runtime provider wiring is deferred; the schema and UI are ready.
- **Longitudinal quality:** deterministic evals compare baseline vs candidate codebase quality across
  checkpoints (duplication, complexity, dependency growth, churn, rework, review time, change failure rate).
- **Lesson-aware context packs:** context packs include approved experience lessons for the factory.

## Capabilities

### Modified Capabilities

- `factory-definition`: review-capacity and experiment configuration.
- `factory-loop`: review-capacity gate, decision-linked PRs.
- `missions`: experiment/rollout metadata.
- `measurement`: longitudinal quality metrics.
- `web-console`: capacity/comprehension cards, decision trail and experiment plan.

## Impact

- Additive schema/config; old factories validate with defaults.
- No DB migration: projections come from existing gates/work-item events/review packets.
- Orchestration: review-capacity check in mission auto-approval and PR body.
- API/Web: autonomy read model, Gates page, work-item detail, mission plan.
- Tests: core capacity resolver, evals, API projection, Playwright.
