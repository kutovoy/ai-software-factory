# Spec Delta

## ADDED Requirements

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
