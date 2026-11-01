# Spec Delta

## ADDED Requirements

### Requirement: Auto-refresh

Data pages SHALL refresh on an interval while the tab is visible.

#### Scenario: Default
- **WHEN** a data page is opened
- **THEN** a top-right control offers Off / 15s / 30s / 60s with 15s selected
- **AND** the page refreshes on that interval

#### Scenario: Persistence
- **WHEN** the interval is changed
- **THEN** the choice persists across pages and reloads

#### Scenario: Documentation routes
- **WHEN** the route is `/help` or any `/help/*` page
- **THEN** no auto-refresh control is shown
- **AND** no refresh timer runs

#### Scenario: Hidden tab
- **WHEN** the tab is not visible
- **THEN** refreshing pauses
- **AND** resumes when visible

#### Scenario: Last refresh
- **WHEN** a refresh completes
- **THEN** the control shows when the data was last refreshed

### Requirement: Operational dashboard

The factory dashboard SHALL show state and output, not only metrics.

#### Scenario: State
- **WHEN** the dashboard loads
- **THEN** it shows autonomy (enabled/paused/override), canary state and last activity

#### Scenario: Work and runs
- **WHEN** the factory has items and runs
- **THEN** recent work items and runs are listed with status and links

#### Scenario: Deliverables
- **WHEN** the factory produced a PR or patch
- **THEN** the dashboard lists PR links and the latest patch/artifact
- **AND** it states where results live (run detail artifacts, PR)

#### Scenario: Empty
- **WHEN** nothing has run yet
- **THEN** the sections say so honestly
- **AND** they do not render empty shells

### Requirement: Stable factory selection

The selected factory SHALL persist across top-level navigation.

#### Scenario: Top-level navigation
- **WHEN** the operator selects factory B and clicks Runs
- **THEN** the sidebar still shows factory B
- **AND** factory-scoped links target B

#### Scenario: Factory route
- **WHEN** the operator opens `/factories/A/...`
- **THEN** A becomes the selected factory

### Requirement: Work-item board filters

The board SHALL hide cancelled items by default and expose status filters and timestamps.

#### Scenario: Default
- **WHEN** the board loads
- **THEN** cancelled items are hidden
- **AND** active/escalated/done items are shown

#### Scenario: Filters
- **WHEN** status chips are toggled
- **THEN** the board shows exactly the selected statuses

#### Scenario: Timestamps
- **WHEN** a card renders
- **THEN** it shows when the item was created and last updated
