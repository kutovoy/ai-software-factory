# Spec Delta

## ADDED Requirements

### Requirement: Mission feature work items

A work item MAY be created as a mission feature and SHALL link back to its mission and feature.

#### Scenario: Mission feature
- **WHEN** a mission dispatches a feature
- **THEN** the work item records `missionId` and `missionFeatureId`
- **AND** its source is `mission`
- **AND** it starts at `implement` because the mission plan supplies the feature spec and acceptance criteria

#### Scenario: Retry
- **WHEN** a mission feature work item is retried
- **THEN** it keeps its mission and feature links
- **AND** it resumes at its current stage under a new attempt
