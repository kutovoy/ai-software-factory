# Spec Delta

## ADDED Requirements

### Requirement: Review capacity and comprehension cards

The Gates page SHALL show review capacity and comprehension projections with honest unknown states.

#### Scenario: Capacity card
- **WHEN** the autonomy read model reports capacity
- **THEN** the page shows open gates, unread diff lines, oldest gate age and saturation
- **AND** it explains how to drain the queue

#### Scenario: Comprehension card
- **WHEN** the read model reports comprehension
- **THEN** the page shows unread diff volume, items without human review and review coverage
- **AND** it never claims a specific human read a specific diff

### Requirement: Experiment and decision trail UI

Mission Control SHALL show experiment metadata, and work-item detail SHALL show the decision trail.

#### Scenario: Experiment
- **WHEN** a plan has experiment metadata
- **THEN** Mission Control shows the flag, metric, guardrail and cleanup window

#### Scenario: Decision trail
- **WHEN** a work item has decisions
- **THEN** the detail page lists plan, gates, review, PR and merge in order
