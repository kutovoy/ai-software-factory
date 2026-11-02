# Spec Delta

## Purpose

Real identities for the console and API: sign-in, sessions, roles, user administration and per-user scope.

## ADDED Requirements

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
