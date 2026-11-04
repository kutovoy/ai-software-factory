# Spec Delta

## ADDED Requirements

### Requirement: Trace evidence

The scoring context SHALL include deterministic trace evidence from the canonical event log
and the review gate verdict.

#### Scenario: Usage and messages
- **WHEN** a run emitted `usage.updated` and assistant `message.completed` events
- **THEN** the evidence records input/output/cache/reasoning tokens, cost, assistant message
  count, assistant character count and final-message characters

#### Scenario: File edits and scope
- **WHEN** a run emitted `file.edited` events or produced a patch
- **THEN** the evidence records changed paths, diff bytes, added/removed lines and patch bytes

#### Scenario: Review verdict
- **WHEN** the work item has a review gate verdict
- **THEN** the evidence records the verdict decision, finding count and summary length

### Requirement: Trace checks

Deterministic scorers SHALL support four trace checks: `redundant_tests`, `verbosity`,
`scope` and `review_usefulness`.

#### Scenario: Redundant tests
- **WHEN** the same test command is executed more than once
- **THEN** `redundant_tests` fails and cites the duplicate count

#### Scenario: Verbosity
- **WHEN** output tokens exceed 6,000 or assistant text exceeds 20,000 characters
- **THEN** `verbosity` fails

#### Scenario: Scope
- **WHEN** a run changes more than 20 files or produces a patch larger than 200,000 bytes
- **THEN** `scope` fails

#### Scenario: Review usefulness
- **WHEN** a review verdict has no findings or a summary shorter than 40 characters
- **THEN** `review_usefulness` fails
- **AND** a non-review run passes with an explicit `not a review run` rationale

### Requirement: Trace metrics on run detail

`GET /api/v1/factories/:factoryId/runs/:id` SHALL return deterministic trace metrics.

#### Scenario: Read
- **WHEN** a run detail is requested
- **THEN** the response includes tool calls, failed tool calls, tokens, cost, message volume,
  file edits, patch bytes, test counts, redundant tests and review usefulness
- **AND** the run page renders the four trace dimensions
