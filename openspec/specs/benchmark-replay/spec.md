# benchmark-replay Specification

## Purpose
Benchmarks can replay a recorded run deterministically.

## Requirements

### Requirement: Recorded replay

The system SHALL replay a recorded run's events and patch into a fresh workspace.

#### Scenario: Replay
- **WHEN** a benchmark trial selects a recording
- **THEN** the recorded events are re-emitted and the recorded patch is applied
- **AND** the trial is scored without a model call

#### Scenario: Missing recording
- **WHEN** the recording directory or patch is absent
- **THEN** the trial fails with `replay_missing`
