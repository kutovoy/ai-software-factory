# Spec Delta

## ADDED Requirements

### Requirement: Longitudinal quality metrics

The measurement layer SHALL compute deterministic longitudinal quality metrics across checkpoints and compare
a candidate against a baseline.

#### Scenario: Degradation
- **WHEN** a candidate increases duplication, complexity, dependency count or rework beyond thresholds
- **THEN** the evaluation reports a regression
- **AND** autonomy can be blocked on that regression

#### Scenario: Missing metrics
- **WHEN** a metric is unavailable
- **THEN** it is reported as unknown
- **AND** it is not treated as zero
