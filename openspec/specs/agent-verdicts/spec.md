# agent-verdicts Specification

## Purpose
Agent gates decide from a structured verdict emitted by the stage agent, with an explicit policy for missing
verdicts.

## Requirements

### Requirement: Structured verdict parsing

The system SHALL parse an agent stage's final summary for a verdict block.

#### Scenario: Approve
- **WHEN** the summary ends with a fenced JSON block `{"verdict":"approve"}`
- **THEN** the gate decision is `approve` with `source: structured`

#### Scenario: Request changes
- **WHEN** the block says `{"verdict":"request_changes","summary":"missing tests"}`
- **THEN** the gate decision is `request_changes` and the summary is the feedback

#### Scenario: Reject
- **WHEN** the block says `{"verdict":"reject"}`
- **THEN** the gate decision is `reject`

#### Scenario: Textual fallback
- **WHEN** there is no JSON block but the summary contains an explicit `VERDICT: FAIL`
- **THEN** the gate decision is `request_changes` with `source: textual`

### Requirement: Missing-verdict policy

The factory SHALL choose what an absent verdict means.

#### Scenario: Advisory
- **WHEN** `agentVerdict` is `advisory` and no verdict is found
- **THEN** the gate approves, preserving pre-verdict behaviour

#### Scenario: Required
- **WHEN** `agentVerdict` is `required` and no verdict is found
- **THEN** the gate requests changes with a reason naming the missing verdict

### Requirement: Auditable verdicts

Gate decisions SHALL retain the verdict that produced them.

#### Scenario: Decision record
- **WHEN** an agent gate resolves
- **THEN** `gate_decisions.verdict` contains the decision, source and summary
- **AND** the work-item gate API returns it

### Requirement: Run summary

A successful run SHALL carry the last assistant message as its summary.

#### Scenario: Structured verdict
- **WHEN** an agent ends with a fenced JSON verdict
- **THEN** `run.completed.summary` contains that final message
- **AND** the required verdict parser can approve, request changes or reject

#### Scenario: No assistant text
- **WHEN** a run produces no assistant text
- **THEN** it still completes; the verdict policy handles the missing verdict
