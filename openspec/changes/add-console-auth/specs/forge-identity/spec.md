# Spec Delta

## Purpose

The local forge attributes requests to the signed-in console user.

## ADDED Requirements

### Requirement: Proxy identity

The forge proxy SHALL assert the session user's forge username.

#### Scenario: Signed in
- **WHEN** a request reaches `/extras/forgejo/*` with a valid session
- **THEN** the proxy sets `X-WebAuth-User` to that user's username

#### Scenario: Auth disabled
- **WHEN** auth is not required
- **THEN** the proxy falls back to `FORGEJO_ADMIN_USER`

#### Scenario: Personal organization
- **WHEN** a user signs in for the first time
- **THEN** the API best-effort creates organization `u-<username>` and makes the user an owner
