# Spec Delta

## ADDED Requirements

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
