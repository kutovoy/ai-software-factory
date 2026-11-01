# Spec Delta

## ADDED Requirements

### Requirement: Work-item retry

An escalated, failed or blocked work item SHALL be retryable without creating a duplicate item.

#### Scenario: Retry escalated
- **WHEN** `POST /api/v1/work-items/:id/retry` is called with actor and reason
- **THEN** the item returns to `active` at its current stage
- **AND** the stage is dispatched again under a new attempt workflow id
- **AND** a `work_item.retried` event records actor, reason and the previous status

#### Scenario: Not retryable
- **WHEN** the item is `active` or `done`
- **THEN** the request is refused with `work_item_not_retryable`
- **AND** the reason names the current status

#### Scenario: Idempotent
- **WHEN** retry is submitted twice within the dedupe window
- **THEN** the second call returns the existing dispatch
- **AND** no second workflow starts

#### Scenario: Cancelled item
- **WHEN** the item was cancelled and is retried
- **THEN** cancellation flags are cleared
- **AND** the audit keeps the prior cancellation as history
