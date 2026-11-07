# Spec Delta

## ADDED Requirements

### Requirement: Connection-failure recovery

The console SHALL keep the current page mounted and explain an API or web-server outage
instead of rendering a blank page or repeatedly navigating.

#### Scenario: Backend becomes unreachable
- **WHEN** the same-origin `/api/v1/health` probe fails or answers `5xx`
- **THEN** a “Server connection issue” banner appears with a manual retry control
- **AND** the current route and shell remain visible
- **AND** auto-refresh pauses until the probe succeeds

#### Scenario: Backend returns
- **WHEN** the health probe succeeds after an outage
- **THEN** the banner disappears
- **AND** the server components refresh once so the page projection catches up

#### Scenario: A route render fails
- **WHEN** a page throws because an API read failed
- **THEN** the route error boundary shows a retry/reload panel inside the shell
- **AND** a root-layout failure shows the same connection message with inline styling
