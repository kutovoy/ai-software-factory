# Spec Delta

## MODIFIED Requirements

### Requirement: Runs list and detail

The console SHALL list runs newest-first with status, factory, definition commit, duration and cost, and
SHALL show a run's steps, events, artifacts and gate context.

#### Scenario: List
- **WHEN** `Runs` is opened
- **THEN** each row shows status, factory, commit (short), started time, duration and cost
- **AND** rows are filterable by factory and status

#### Scenario: Detail
- **WHEN** a run is opened
- **THEN** the page shows the pinned `definitionCommit`, harness, model, steps and artifact links
- **AND** the event stream renders from the beginning then tails live

#### Scenario: Manual run GC
- **WHEN** an operator opens the Runs page
- **THEN** a GC control accepts actor, reason, optional days/keep and dry-run
- **AND** it reports scanned, removed, kept and protected counts

## ADDED Requirements

### Requirement: Budget and quota panel

The factory dashboard SHALL show the budget and quota state.

#### Scenario: Budget panel
- **WHEN** a factory declares spend or concurrency quotas
- **THEN** the dashboard shows lifetime, day and month spend against their caps
- **AND** it shows active runs against the concurrency cap
- **AND** an exhausted cap is visibly marked

#### Scenario: Canary prune
- **WHEN** an operator opens the self-improvement page
- **THEN** the canary prune control reports kept, removed and protected candidate trees
