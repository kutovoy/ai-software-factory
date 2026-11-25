# Design

## Review capacity

`quality.reviewCapacity` defaults:

- `maxOpenGates`: 20
- `maxUnreadDiffLines`: 4000
- `maxGateAgeHours`: 48
- `maxReviewHoursPerWeek`: 20

The projection counts pending gates for the factory, sums the diff lines of their newest review packets and
computes the oldest gate age. `saturated` is true when any cap is exceeded. Mission plan auto-approval returns
`autoApprove: false` with a `review_capacity_exceeded` reason. Enabling full autonomy is refused unless an
explicit audited override is supplied.

## Comprehension

`GET /autonomy` adds a `comprehension` object:

- `unreadDiffLines`: sum of diff lines in non-terminal items whose newest packet has no human gate.
- `itemsWithoutHumanReview`: active/done items with no human `gate.decided`.
- `modulesWithoutHumanTouch`: count of distinct top-level paths in review packets with no human review.
- `reviewCoveragePercent`: human-reviewed items / items with a review packet.

These are aggregate, honest proxies; they never claim a human read a specific diff.

## Decision trail

PR bodies include work item, mission/plan ref, risk tier, context-pack ref, review-packet ref and the assertion
summary. Work-item detail renders a chronological trail: plan ref, gate decisions, review verdicts, PR, merge
and incidents. The event log remains the source of truth.

## Experiments

`experiments` config:

```yaml
experiments:
  provider: posthog   # posthog | statsig | launchdarkly | generic
  projectKeySecret: POSTHOG_KEY
  flagPrefix: factory_
  requireCleanup: true
```

Mission plan `experiment`:

```ts
{ flag: string; successMetric: string; guardrail?: string; cleanupAfterDays?: number }
```

No provider call is made in P1; the plan and UI make the experiment explicit and auditable.

## Longitudinal quality

`packages/evals/src/longitudinal.ts` compares checkpoint metrics:

- duplication percent, cyclomatic complexity, lines per symbol, dependency count
- churn/rework, review time, change failure rate
- public API/schema changes

The result is deterministic and model-free; it can gate autonomy when a candidate worsens the baseline.

## Lessons

Context packs include the factory's newest approved lessons (bounded, provenance-labelled). Unapproved or
shared lessons are excluded unless explicitly promoted.
