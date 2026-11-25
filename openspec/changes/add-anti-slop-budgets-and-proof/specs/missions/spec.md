# Spec Delta

## ADDED Requirements

### Requirement: Plan depth and leverage

Mission plans SHALL carry `planDepth`, `expectedPain` and `leverage` so small changes stay light and
high-cost changes receive full upstream design.

#### Scenario: Small change
- **WHEN** a plan is low risk and reversible
- **THEN** it may use a light plan without full architecture/program-design sections

#### Scenario: High-cost change
- **WHEN** a plan touches data, schema or a high-risk path
- **THEN** it uses a full plan
- **AND** it waits for a human plan gate

### Requirement: Visual plan artifacts

Medium/high-risk UI plans SHALL reference at least one visual artifact (mockup, diagram or HTML page).

#### Scenario: UI plan
- **WHEN** a medium/high-risk plan changes a user-visible surface
- **THEN** the plan references a visual artifact
- **AND** Mission Control renders or links it
