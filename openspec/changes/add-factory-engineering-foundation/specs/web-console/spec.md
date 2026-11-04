# Spec Delta

## Purpose

Add the readiness page, work-item validation panel, outcome metrics and Factory Stack help.

## ADDED Requirements

### Requirement: Readiness page

The console SHALL provide a factory readiness page.

#### Scenario: Page
- **WHEN** `/factories/<id>/readiness` is opened
- **THEN** it shows the overall score, status, repository and factory sections
- **AND** failing checks show evidence and remediation
- **AND** the page is linked from the sidebar and dashboard

#### Scenario: Honest empty state
- **WHEN** the API cannot compute readiness
- **THEN** the page says so instead of rendering a fabricated score

### Requirement: Validation panel

The work-item detail SHALL show the validation contract and its evidence.

#### Scenario: Contract
- **WHEN** a work item has a validation contract
- **THEN** the detail shows each check, tier, status and evidence
- **AND** it shows whether the contract is complete and which checks are missing

#### Scenario: No contract
- **WHEN** the item has no contract
- **THEN** the detail shows an explicit empty state

### Requirement: Outcome metrics

The dashboard SHALL show the new outcome metrics with their units and definitions.

#### Scenario: Cards
- **WHEN** metrics are available
- **THEN** the dashboard shows human interactions per PR, autonomy ratio, cost per accepted change, signal-to-production cycle time, incident MTT and merged-code age
- **AND** null metrics show the reason

### Requirement: Factory Stack help

The help centre SHALL explain the factory stack.

#### Scenario: Entry
- **WHEN** `/help/concepts/factory-stack` is opened
- **THEN** it shows the 00–06 layers
- **AND** it links to the relevant help entries and dashboard

#### Scenario: Navigation
- **WHEN** the help menu reference is rendered
- **THEN** the readiness page has an entry
- **AND** the stack page is linked from the dashboard
