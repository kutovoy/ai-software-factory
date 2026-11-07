# console-auth Specification

## Purpose
Real identities for the console and API: sign-in, sessions, roles, user administration and per-user scope.

## Requirements

### Requirement: Sign-in and sessions

The system SHALL authenticate users with a password and an opaque session cookie.

#### Scenario: Login
- **WHEN** a valid email/password is posted to `/api/v1/auth/login`
- **THEN** a session is created and `factory_session` is set HttpOnly

#### Scenario: Invalid login
- **WHEN** the password is wrong
- **THEN** the response is `401 invalid_credentials` and no session is created

#### Scenario: Logout
- **WHEN** the user logs out
- **THEN** the session is revoked and the cookie is cleared

#### Scenario: Enforcement
- **WHEN** `AUTH_REQUIRED=1` and a protected route is called without a session
- **THEN** the API returns `401 auth_required`
- **AND** the console redirects to `/login`

### Requirement: User administration

Admins SHALL manage users.

#### Scenario: List
- **WHEN** an admin opens `/users`
- **THEN** users are listed with role and status

#### Scenario: Create
- **WHEN** an admin creates a user with email, username, role and password
- **THEN** the user can sign in

#### Scenario: Non-admin
- **WHEN** a member calls a user-management route
- **THEN** the response is `403 forbidden`

### Requirement: Per-user scope

Members SHALL only see their own work.

#### Scenario: List items
- **WHEN** a member lists work items or runs
- **THEN** only items they created are returned

#### Scenario: Admin
- **WHEN** an admin lists work items
- **THEN** all items are returned

### Requirement: Delete a user

Admins SHALL be able to delete an account.

#### Scenario: Delete
- **WHEN** an admin deletes another account
- **THEN** the account and its sessions are removed
- **AND** the response is `{deleted:true}`

#### Scenario: Self-delete
- **WHEN** an admin tries to delete their own account
- **THEN** the request is refused with `invalid_user`

#### Scenario: Last admin
- **WHEN** deleting an active admin would leave no active admins
- **THEN** the request is refused with `invalid_user`

#### Scenario: Member
- **WHEN** a member calls the delete route
- **THEN** the response is `403 forbidden`

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
