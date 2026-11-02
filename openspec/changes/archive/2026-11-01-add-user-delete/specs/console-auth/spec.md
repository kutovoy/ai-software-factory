# Spec Delta

## Purpose

User administration includes safe account deletion.

## ADDED Requirements

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
