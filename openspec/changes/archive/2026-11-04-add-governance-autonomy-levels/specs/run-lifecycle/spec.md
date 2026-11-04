# Spec Delta

## ADDED Requirements

### Requirement: Policy-governed permissions

Unattended factory runs SHALL evaluate every permission request against the governance
policy before allowing it.

#### Scenario: Allow
- **WHEN** the policy allows the action
- **THEN** the permission is auto-allowed as before

#### Scenario: Deny
- **WHEN** the policy denies or requires a human
- **THEN** the permission is denied
- **AND** a `policy` step records `{action, decision, reason}`

#### Scenario: Chat
- **WHEN** a chat run requests a permission
- **THEN** the existing human durable wait is unchanged
