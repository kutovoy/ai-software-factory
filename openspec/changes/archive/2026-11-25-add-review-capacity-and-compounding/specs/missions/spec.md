# Spec Delta

## ADDED Requirements

### Requirement: Experiment metadata

Mission plans SHALL carry optional experiment metadata: flag, success metric, guardrail and cleanup window.

#### Scenario: Experiment plan
- **WHEN** a plan includes an experiment
- **THEN** Mission Control shows the flag, metric, guardrail and cleanup window
- **AND** the plan gate records the experiment reference

### Requirement: Plan decision trail

Mission Control and work-item detail SHALL show a chronological decision trail from plan through gates,
review, PR and merge.

#### Scenario: Decision trail
- **WHEN** a work item has gate decisions, review verdicts and a PR
- **THEN** the detail page lists them in order with actor/reason
