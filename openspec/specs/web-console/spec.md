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

### Requirement: Pinned sidebar footer

The sidebar SHALL remain a fixed-height, independently scrolling column so its footer stays visible.

#### Scenario: Long page
- **WHEN** a long page (e.g. Help) is open
- **THEN** the sidebar does not grow with the page
- **AND** the usage/account/help footer remains visible at the bottom left
- **AND** only the sidebar's nav list scrolls

#### Scenario: Short page
- **WHEN** a short page is open
- **THEN** the footer sits at the bottom of the viewport
- **AND** the layout does not shift between pages

### Requirement: API reference in help

The console SHALL expose the HTTP API inside the product.

#### Scenario: Nav entry
- **WHEN** the sidebar is rendered
- **THEN** an `API` entry appears above `Help`
- **AND** it opens the API help entry

#### Scenario: Reference
- **WHEN** the API help entry loads
- **THEN** it lists every endpoint with method, path, purpose and parameters
- **AND** it links to the raw OpenAPI document

### Requirement: Supported projects guidance

Help SHALL state what the factory can and cannot build.

#### Scenario: In scope
- **WHEN** the supported-projects entry is read
- **THEN** it explains that the unit of work is a repository diff verified by checks
- **AND** it gives examples: application code, tests, documentation, configuration, Terraform modules and plans

#### Scenario: Out of scope
- **WHEN** a request needs applying infrastructure, physical action, or an artefact no check can verify
- **THEN** the entry says the factory will produce a proposal/PR at most
- **AND** it does not claim the factory performs the action

### Requirement: Executable API explorer

The API help entry SHALL provide a live Swagger UI that can execute requests.

#### Scenario: Render
- **WHEN** `/help/api` loads
- **THEN** the explorer renders operations from the served OpenAPI document
- **AND** "Try it out" is available on each operation

#### Scenario: Execute
- **WHEN** an operation is executed
- **THEN** the request goes to the console origin (`/api/v1/...`), never directly to the API host
- **AND** the response status and body are shown

#### Scenario: Destructive endpoint
- **WHEN** an operation can mutate state
- **THEN** the page states that actions run against this stack
- **AND** it states that the local API has no authentication

#### Scenario: Degraded
- **WHEN** JavaScript is unavailable or the document cannot be fetched
- **THEN** a static reference of the endpoints is still readable
- **AND** no empty shell is shown

### Requirement: Same-origin API proxy

The console SHALL expose `/api/v1/*` as a same-origin proxy to the backend.

#### Scenario: Forward
- **WHEN** a request hits `/api/v1/<path>` with any method
- **THEN** it is forwarded to the backend's `/api/v1/<path>` with query, body and headers
- **AND** the response status, headers and body are returned unchanged

#### Scenario: Unknown path
- **WHEN** the backend returns 404
- **THEN** the proxy returns 404 with the backend's error body

### Requirement: Explorer presentation parity

The API explorer SHALL use the available width and expose search, sorting and request metadata.

#### Scenario: Full width
- **WHEN** `/help/api` renders at 1280px or wider
- **THEN** the explorer uses the content width rather than a narrow column
- **AND** prose blocks stay readable

#### Scenario: Filter and sort
- **WHEN** the explorer is shown
- **THEN** a filter box narrows operations
- **AND** tags and operations are sorted alphabetically
- **AND** each executed request shows its duration

#### Scenario: Tag context
- **WHEN** a tag group is expanded
- **THEN** its description is shown

### Requirement: Truthful server selector

The explorer's Servers selector SHALL name the origin that requests actually use.

#### Scenario: Console origin
- **WHEN** the console loads the explorer document
- **THEN** the server entry is the console origin (`/`), not the backend host
- **AND** executing an operation reaches `/api/v1/...` through the same-origin proxy

#### Scenario: Raw document
- **WHEN** a client fetches `/api/v1/openapi.json` without the console parameter
- **THEN** the document keeps the direct API server for Swagger UI/Postman use

### Requirement: Contextual run actions

The run page SHALL only offer actions that apply to the run's state.

#### Scenario: Live run
- **WHEN** the run is `pending`, `running` or `cancelling`
- **THEN** "Cancel run" is shown and enabled

#### Scenario: Terminal run
- **WHEN** the run is `ok`, `error` or `cancelled`
- **THEN** no cancel control is rendered
- **AND** the terminal status is shown instead

#### Scenario: Stage run
- **WHEN** the run belongs to a factory stage
- **THEN** no per-run retry is offered
- **AND** the page links to the work item where retry lives

#### Scenario: Chat run
- **WHEN** a chat run failed or was cancelled
- **THEN** "Retry as new run" remains available

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

### Requirement: Non-overlapping run metadata

Run metadata cells SHALL not overlap, including long commit SHAs.

#### Scenario: Long commit
- **WHEN** a run page renders a 40-character commit
- **THEN** the cell shows a short SHA with the full value available
- **AND** it does not overlap the harness/model cell

#### Scenario: Narrow viewport
- **WHEN** the page is narrower than the four-column breakpoint
- **THEN** cells reflow without horizontal overflow

### Requirement: Retry control

The run page SHALL offer retry where it is valid, and its failure copy SHALL match reality.

#### Scenario: Eligible run
- **WHEN** a chat run ends `error` or `cancelled`
- **THEN** the page shows "Retry as new run"
- **AND** activating it navigates to the new run
- **AND** it is disabled while the request is in flight

#### Scenario: Ineligible run
- **WHEN** the run is `ok`, `running`, or a factory stage run
- **THEN** no retry control is shown
- **AND** the page explains where retry belongs (the work item) for stage runs

#### Scenario: Truthful copy
- **WHEN** the failure panel advises next steps
- **THEN** it references the retry control that exists
- **AND** it does not promise an action the page cannot perform

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

### Requirement: Batch inbox and board reads

The console SHALL render the inbox and work-items board from batch projections.

#### Scenario: Inbox
- **WHEN** `/inbox` renders
- **THEN** it makes one `/inbox` request
- **AND** it does not fetch per-factory run/work-item lists or per-item details

#### Scenario: Board
- **WHEN** a factory work-items page renders
- **THEN** it makes one `view=board` request
- **AND** pending gates and run links come from that response
- **AND** status counts come from the server

### Requirement: Request-scoped memoization

Factory reads SHALL be deduplicated within one server render.

#### Scenario: Layout and page
- **WHEN** the layout and a page both need the factory list
- **THEN** they share one upstream `/factories` call

#### Scenario: Factory detail
- **WHEN** multiple server components need the same factory detail
- **THEN** they share one upstream detail call

### Requirement: Honest loading states

The inbox and board SHALL render an explicit loading state while data streams.

#### Scenario: Loading
- **WHEN** the batch projection is still loading
- **THEN** the page shows skeleton rows and an `aria-busy` region
- **AND** it does not fabricate counts or cards

### Requirement: Platform-aware Runners console

The Runners console SHALL allow enrolling Linux, Windows and macOS hosts and SHALL explain
the platform-specific install path.

#### Scenario: Add runner
- **WHEN** an operator selects Windows or macOS in the add-runner wizard
- **THEN** the enrollment response shows the matching preflight and install commands
- **AND** the platform is not disabled

#### Scenario: Host detail
- **WHEN** a host reports metrics
- **THEN** the host list and detail page show platform/arch, CPU/RAM/disk, leases and alerts
- **AND** a missing metric remains `—` rather than becoming zero

### Requirement: Artifact download links

The run detail page SHALL link stored artifacts to the authenticated download route.

#### Scenario: Stored artifact link
- **WHEN** an artifact has a `storageKey`
- **THEN** the run detail shows a download link
- **AND** the link uses the run-scoped artifact route

### Requirement: Runners E2E coverage

The web E2E suite SHALL cover the Runners enrollment, host detail, metrics, alert and delete
flows.

#### Scenario: Enrollment and heartbeat
- **WHEN** the Runners spec creates an enrollment and posts a simulated heartbeat
- **THEN** the host appears in the list and detail page with the reported metrics

#### Scenario: Alert and cleanup
- **WHEN** a high-CPU heartbeat is posted
- **THEN** a firing alert appears and can be acknowledged
- **AND** the created host is deleted in cleanup
