# web-console Specification

## Purpose
Defines the web console: navigation parity, live run rendering shared by chat and factory runs, the
personal inbox, and read-only factory pages — all consuming `apps/api` only.

## Requirements

### Requirement: Navigation parity

The console SHALL expose the reference product's navigation: `New Chat`, `Inbox`, `Runs`,
`MCPs and apps`, `Secrets`, `Users`, plus a per-factory group (`Dashboard`, `Agents`, `Automations`,
`Scorers`, `Self-improvement`, `Benchmarks`, `Definition`, `Gates`, `Settings`) and a factory switcher.

#### Scenario: Factory-scoped navigation
- **WHEN** a factory is selected
- **THEN** the per-factory group shows that factory's pages
- **AND** switching factories changes the group's data without a full page reload

#### Scenario: Unimplemented page
- **WHEN** a page whose phase has not shipped is opened
- **THEN** it renders an explicit empty state naming the phase that will fill it
- **AND** it does not error or show fabricated data

#### Scenario: Active state
- **WHEN** a route is open
- **THEN** its nav item is marked active and is reachable by keyboard

### Requirement: Chat streams through the runner

`New Chat` SHALL submit a prompt to `POST /chat` and render the resulting `FactoryEvent` stream live,
including tool calls, diffs and permission requests.

#### Scenario: Live stream
- **WHEN** a prompt is submitted
- **THEN** a run is created and events appear as they arrive
- **AND** tool calls render with name, arguments and result status
- **AND** the run reaches a terminal state shown in the header

#### Scenario: Reconnect
- **WHEN** the page is reloaded mid-run
- **THEN** the stream resumes from the last seen `seq` without duplicates or gaps

#### Scenario: Permission prompt
- **WHEN** a `permission.requested` event arrives
- **THEN** the prompt renders inline with allow/deny actions
- **AND** choosing one posts to `/runs/:id/permissions/:requestId`
- **AND** the prompt resolves to the outcome

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

### Requirement: Inbox

The inbox SHALL list only items requiring the current user's action and SHALL deep-link each to its run.

#### Scenario: Pending permission
- **WHEN** a run has an unanswered permission request
- **THEN** the inbox shows it with run, factory and age
- **AND** acting on it opens the run with the permission focused

#### Scenario: Failure
- **WHEN** a run ends with `status: error`
- **THEN** the inbox shows it with the error code
- **AND** the item auto-resolves when the run is retried successfully

#### Scenario: Empty
- **WHEN** nothing needs attention
- **THEN** the inbox shows an explicit empty state

### Requirement: Factory pages are read-only projections

Factory pages SHALL read from `apps/api` and SHALL NOT write definitions.

#### Scenario: Definition page
- **WHEN** `Definition` is opened
- **THEN** it shows the resource tree, the resolved gates table, version (commit, tag, content hash),
  and a diff against the previous version
- **AND** it states that definitions are edited in git

#### Scenario: Gates page
- **WHEN** `Gates` is opened
- **THEN** every stage is listed with its resolved gate (`human`/`agent`/`policy:<name>`), the resolution
  source, and the merge policy
- **AND** a fully autonomous factory is flagged with the benchmark-gate requirement

#### Scenario: Agents page
- **WHEN** `Agents` is opened
- **THEN** each agent shows role, harness/model, runner, tools and secrets (names only)

### Requirement: Accessibility and layout stability

The console SHALL be keyboard-navigable and SHALL NOT shift layout as events stream in.

#### Scenario: Keyboard only
- **WHEN** a user navigates with Tab/Enter only
- **THEN** every nav item, action and permission prompt is reachable and operable

#### Scenario: Streaming stability
- **WHEN** events arrive while a run is open
- **THEN** existing content does not reflow vertically
- **AND** the event list auto-scrolls only when the user is already at the bottom

### Requirement: End-to-end coverage

A Playwright suite SHALL cover the core loop against `docker compose` with the fake harness.

#### Scenario: Chat to terminal
- **WHEN** the suite submits a prompt in New Chat
- **THEN** it observes tool-call events, approves the permission, and asserts the terminal state
- **AND** it asserts no provider key appears in the rendered run detail

#### Scenario: Replay
- **WHEN** the suite reloads the run page mid-stream
- **THEN** the rendered event sequence continues without duplicates

#### Scenario: Navigation
- **WHEN** the suite visits every nav item
- **THEN** each page renders without console errors
- **AND** stub pages name their phase

### Requirement: Consistent factory heading

Every factory page SHALL render the factory heading from one source (alias, falling back to the directory
name), and two factories SHALL be distinguishable.

#### Scenario: Same heading everywhere
- **WHEN** any factory page renders
- **THEN** the heading prefix is identical across Dashboard, Agents, Automations, Benchmarks, Definition,
  Gates, Merge queue, Scorers, Self-improvement and Settings

#### Scenario: Distinct factories
- **WHEN** two factories are loaded
- **THEN** their aliases differ
- **AND** the switcher and headings identify which one is open

### Requirement: Truthful status copy

Status text SHALL describe the state it is rendered from.

#### Scenario: Attestation not required
- **WHEN** a benchmark attestation is not required because human gates remain
- **THEN** the copy says so
- **AND** it does not claim an attestation matches the version

#### Scenario: Canary configured
- **WHEN** the authority is `canary` but no rollout is active
- **THEN** the copy says the authority is enabled
- **AND** active-rollout state is reported separately

### Requirement: No horizontal overflow

Pages SHALL fit the viewport at 1280px, and long unbroken values SHALL wrap or scroll inside their card.

#### Scenario: Long config value
- **WHEN** a resolved configuration contains a long unbroken string
- **THEN** the page does not scroll horizontally
- **AND** the value remains readable

### Requirement: Attributable references

Secret references SHALL name the factory they come from, so identical references in two factories are not
shown as duplicates.

#### Scenario: Same name, two factories
- **WHEN** two factories reference the same secret at the same pointer
- **THEN** the list shows one row per factory
- **AND** each row names its factory

### Requirement: Pluralisation

Counts SHALL be rendered with correct singular/plural forms.

#### Scenario: One server
- **WHEN** a factory declares one MCP server
- **THEN** the label reads `1 server`, not `1 servers`

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
