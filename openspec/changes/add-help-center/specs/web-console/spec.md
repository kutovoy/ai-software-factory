# Spec Delta

## ADDED Requirements

### Requirement: Help centre

The console SHALL provide an in-product help centre covering every menu item, factory setup, and the concepts
behind the loop.

#### Scenario: Index
- **WHEN** `/help` is opened
- **THEN** it lists Quick start, Concepts, Menu reference, Factory how-tos and Troubleshooting
- **AND** each entry links to a real page

#### Scenario: Menu reference
- **WHEN** the menu reference is opened
- **THEN** every top-level and per-factory nav item has an entry describing purpose, what the page shows and
  the actions available

#### Scenario: Quick start
- **WHEN** the quick start is opened
- **THEN** it shows the pipeline and gate flow as diagrams
- **AND** it gives copy-paste commands from `docker compose up` to a merged work item
- **AND** it states the expected observable result at each step

### Requirement: Contextual help

Every page SHALL expose a help control that links to the help entry for that page.

#### Scenario: Known page
- **WHEN** a page renders
- **THEN** a `?` control in the top-right links to its help entry
- **AND** the control has an accessible name naming the page

#### Scenario: Unknown page
- **WHEN** a route has no help entry
- **THEN** the control links to the help index
- **AND** it does not 404

### Requirement: No dead controls

Interactive-looking controls SHALL either act or be removed.

#### Scenario: Add factory
- **WHEN** the `+` next to Factories is activated
- **THEN** it opens the "Add a factory" how-to
- **AND** the page states that factories are git-backed files and that the console never writes the worktree

#### Scenario: Non-interactive label
- **WHEN** an element is decorative
- **THEN** it is not styled or announced as a control

### Requirement: Help stays current

Help content SHALL be updated in the same change as the feature it describes.

#### Scenario: Feature change
- **WHEN** a page, route or capability changes
- **THEN** the matching help entry and the menu reference are updated
- **AND** the change's tasks include that update
