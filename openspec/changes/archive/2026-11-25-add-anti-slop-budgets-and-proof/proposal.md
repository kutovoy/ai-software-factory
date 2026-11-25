# Proposal

## Why

The factory can generate changes faster than a human can review and understand them. Research from the
`12 Rules for a Software Factory That Doesn't Ship Slop` talk and the `Build the Workshop Before the
Software Factory` talk converge on the same failure mode: production is cheap, review and comprehension are
scarce, and slop compounds when the next agent copies it. Our current review packet is a status card, not a
decision surface: it shows diff size and assertions, but not blast radius, proof, budget overages, decisions
or what a reviewer should read first.

## What Changes

- **Risk-tiered slop budgets:** a `quality.slopBudget` block caps diff lines, changed files, new
  dependencies, duplication delta and complexity delta per risk tier; overages stop the loop or require a
  human waiver.
- **Proof artifacts:** UI/behavioral changes must attach run-scoped proof (screenshot, video, HTML explainer,
  curl transcript or test report); missing proof blocks verify.
- **Review packet v2:** add blast radius, budget vs actual, proof artifacts, a deterministic `readFirst`
  list, gate decisions, reviewer roles and comprehension estimates.
- **Visual alignment:** vendor a `show-me` skill and require an HTML mockup/diagram for medium/high UI plans;
  `productReview.mockups` becomes artifact references rather than bare strings.
- **Context pack:** every feature/work item receives a deterministic bundle of ADRs, architecture
  constraints, prior related PRs/failures, test standards and relevant files.
- **Anti-slop toolpack:** vendor an anti-slop skill and deterministic rules; infer an `anti-slop` script as a
  maintainability check and fail verify on violations.
- **Plan depth:** missions and work items carry `planDepth`/`expectedPain`/`leverage` so small changes stay
  light and high-cost changes get full upstream design.

## Capabilities

### Modified Capabilities

- `factory-definition`: `quality` block and slop budget schema.
- `validation-contract`: proof artifact requirements and anti-slop checks.
- `factory-loop`: slop stop conditions, context packs and review-packet v2.
- `missions`: plan depth/leverage metadata and visual artifacts.
- `web-console`: review packet v2, proof gallery, plan depth and context links.

## Impact

- Additive schema defaults; old factories and plans keep validating.
- No DB migration: metrics, proof references and context packs live in events/artifacts/JSON.
- Orchestration: patch metrics, review packet, context pack, stage prompts, verify enforcement.
- Web/API: work-item detail, Inbox, Mission Control, help.
- Tests: core quality, orchestration packet/context, API projection, Playwright.
