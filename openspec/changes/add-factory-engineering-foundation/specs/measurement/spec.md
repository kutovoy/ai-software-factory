# Spec Delta

## Purpose

Add outcome and autonomy metrics without changing the existing metric keys.

## ADDED Requirements

### Requirement: Human interactions per PR

The metrics endpoint SHALL report human interactions per PR.

#### Scenario: Value
- **WHEN** PR work items have human gate and permission decisions
- **THEN** `humanInteractionsPerPr` is the count of those decisions divided by PRs opened in the window
- **AND** the definition and sample size are included

#### Scenario: No PRs
- **WHEN** no PRs were opened in the window
- **THEN** the value is `null` with a reason
- **AND** no zero is fabricated

### Requirement: Autonomy ratio

The metrics endpoint SHALL report the share of PR work items with no human touchpoint.

#### Scenario: Value
- **WHEN** PR items have gate and permission decisions
- **THEN** `autonomyRatio` is the percentage of those items with zero human touchpoints
- **AND** automatic gates do not count as human touchpoints

#### Scenario: Attribution
- **WHEN** a permission decision belongs to a stage run
- **THEN** it is attributed to the run's work item
- **AND** a permission that cannot be attributed is not silently assigned

### Requirement: Cost per accepted change

The metrics endpoint SHALL report cost per accepted change.

#### Scenario: Value
- **WHEN** PR work items reached `done`
- **THEN** `costPerAcceptedChange` is attributed run cost divided by accepted PR count
- **AND** only `done` PR items are included

### Requirement: Signal-to-production cycle time

The metrics endpoint SHALL report cycle time for non-manual work items.

#### Scenario: Value
- **WHEN** a non-manual PR item reached `done`
- **THEN** `signalToProductionCycleTime` averages creation to done
- **AND** manual items are excluded

### Requirement: Incident MTT

The metrics endpoint SHALL report mean time to resolution for incident items.

#### Scenario: Value
- **WHEN** incident work items reached `done`
- **THEN** `incidentMttHours` averages creation to done
- **AND** non-incident items are excluded

### Requirement: Merged-code age

The metrics endpoint SHALL report the average age of merged code in the window.

#### Scenario: Value
- **WHEN** PR items reached `done`
- **THEN** `mergedCodeAgeDays` averages the time from done to the window end
- **AND** the definition states that this is an age proxy, not a revert-based shelf-life measure
