# Spec Delta

## ADDED Requirements

### Requirement: Autonomy read model

The console SHALL read autonomy state from the API rather than deriving it from work-item events.

#### Scenario: Read
- **WHEN** `GET /autonomy?factory=` is called
- **THEN** it returns the declared policy, whether autonomy is enabled or paused, the last actor/reason/time
- **AND** it returns the newest `autonomy.*` event as evidence

#### Scenario: No state
- **WHEN** autonomy was never enabled
- **THEN** the response states `enabled: false` with a reason
- **AND** it does not invent a timestamp

### Requirement: Work-item cancellation

A work item SHALL be cancellable, idempotently and with an audit trail.

#### Scenario: Cancel
- **WHEN** `POST /work-items/:id/cancel` carries an actor and reason
- **THEN** the in-flight stage workflow is cancelled
- **AND** the item ends `cancelled` with a `work_item.cancelled` event

#### Scenario: Repeat
- **WHEN** cancel is called again
- **THEN** the same terminal state is returned
- **AND** no second event is emitted

#### Scenario: Terminal item
- **WHEN** the item is already done or failed
- **THEN** the request is refused with `invalid_state`

### Requirement: Automation attestation parity

Work items created by automations SHALL follow the same autonomy/attestation path as manual items.

#### Scenario: Missing attestation
- **WHEN** an automation creates a work item while autonomy requires a benchmark attestation
- **AND** no matching attestation exists
- **THEN** the item runs with human gates
- **AND** an `autonomy.attestation_missing` event records why (no silent downgrade)
