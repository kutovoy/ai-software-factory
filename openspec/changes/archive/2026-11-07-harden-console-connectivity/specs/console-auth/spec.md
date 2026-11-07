# Spec Delta

## ADDED Requirements

### Requirement: Session resolution during an API outage

The console SHALL distinguish an answered unauthenticated response from an unreachable API
when resolving the session.

#### Scenario: API answers without a session
- **WHEN** `AUTH_REQUIRED=1` and `/auth/me` answers `401` or returns no user
- **THEN** a protected page redirects to `/login?next=…`

#### Scenario: API is unreachable
- **WHEN** `AUTH_REQUIRED=1` and `/auth/me` fails with a network error, timeout or `5xx`
- **THEN** the console renders the protected page in degraded mode
- **AND** it does not redirect to `/login`
- **AND** the sidebar says “Session unavailable” rather than “Not signed in”
