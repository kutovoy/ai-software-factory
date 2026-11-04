---
agents:
  - implement
  - review
  - qa
description: Grades the run trace for redundant tests, verbosity, scope and review usefulness.
judgeModel: env:FACTORY_SMALL_MODEL
labels:
  - description: The trace is efficient and evidence-backed.
    score: 1
    value: efficient
  - description: The trace shows waste, redundant work or an unhelpful review.
    score: 0
    value: wasteful
output: classification
passingScore: 1
samplingRate: 100
selfImprovement: true
---

checks:
  - redundant_tests
  - verbosity
  - scope
  - review_usefulness

These checks are deterministic. A failure is evidence for a self-improvement proposal:
redundant test commands point at a retry/loop defect, verbosity points at prompt scope,
scope points at an over-wide edit, and review usefulness points at a review prompt that
does not produce actionable findings.
