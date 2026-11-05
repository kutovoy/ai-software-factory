# Spec Delta

## ADDED Requirements

### Requirement: Host metrics

The agent SHALL report CPU, RAM, disk/inode and host health metrics; the API SHALL store
them centrally.

#### Scenario: Heartbeat metrics
- **WHEN** an agent heartbeats
- **THEN** CPU percent, load averages, memory/swap, per-mount disk/inode usage, uptime,
  process count, agent version and lease count are stored
- **AND** the host's `last_heartbeat` and status are updated

#### Scenario: History
- **WHEN** `GET /api/v1/runners/:id/metrics?window=1h` is requested
- **THEN** the response contains ordered samples for that window

### Requirement: Alert rules

The API SHALL evaluate configurable rules on heartbeat ingest and a worker loop for stale
heartbeats.

#### Scenario: Threshold
- **WHEN** a metric crosses a rule threshold for its duration
- **THEN** a firing alert is created or refreshed
- **AND** the dedupe key is `(host, rule)`

#### Scenario: Recovery
- **WHEN** the metric returns below the threshold
- **THEN** the alert is resolved

#### Scenario: Missing heartbeat
- **WHEN** a host has not heartbeated for the configured age
- **THEN** a heartbeat alert fires
- **AND** the host becomes `unreachable`

### Requirement: Alert lifecycle

Alerts SHALL support acknowledge, silence and resolve states with an audit actor.

#### Scenario: Acknowledge
- **WHEN** an operator acknowledges a firing alert
- **THEN** its state becomes `acknowledged`
- **AND** the actor and time are recorded

#### Scenario: Silence
- **WHEN** an operator silences an alert until a time
- **THEN** it is excluded from firing notifications until that time
- **AND** it remains visible in the alert list

#### Scenario: Inbox and webhook
- **WHEN** an alert fires
- **THEN** it appears in the console alert surface
- **AND** a configured webhook delivery is recorded

### Requirement: Console visibility

The console SHALL show runner health and alerts.

#### Scenario: Runner list
- **WHEN** the Runners page loads
- **THEN** each host shows platform, pool, status, last heartbeat, CPU/RAM/disk usage,
  running leases and active alert count

#### Scenario: Add runner
- **WHEN** an operator creates an enrollment
- **THEN** the page shows the preflight command, the install command and preflight status

#### Scenario: Alert actions
- **WHEN** an operator acknowledges or silences an alert
- **THEN** the list refreshes with the new state
