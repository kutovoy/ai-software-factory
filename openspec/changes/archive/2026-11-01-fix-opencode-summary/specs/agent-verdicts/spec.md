# Spec Delta

## Purpose

Successful harness runs expose the final assistant message as the run summary.

## ADDED Requirements

### Requirement: Run summary

A successful run SHALL carry the last assistant message as its summary.

#### Scenario: Structured verdict
- **WHEN** an agent ends with a fenced JSON verdict
- **THEN** `run.completed.summary` contains that final message
- **AND** the required verdict parser can approve, request changes or reject

#### Scenario: No assistant text
- **WHEN** a run produces no assistant text
- **THEN** it still completes; the verdict policy handles the missing verdict
