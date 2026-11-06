# quotas Specification

## Purpose
Defines per-factory cost and concurrency quotas: the daily/monthly spend caps, the concurrent-run limit,
admission refusal and the budget projection the console reads.

## Requirements

### Requirement: Quota configuration

A factory SHALL be able to declare daily and monthly spend caps and a concurrent-run quota.

#### Scenario: Valid quota
- **WHEN** `budget.maxCostUsdPerDay`, `budget.maxCostUsdPerMonth` and
  `budget.maxConcurrentRuns` are declared
- **THEN** the definition validates
- **AND** the budget endpoint reports each cap with current usage

#### Scenario: Invalid quota
- **WHEN** a quota is negative or a concurrency limit is below one
- **THEN** validation fails with `invalid_value`

### Requirement: Quota admission

New runs and work items SHALL be refused when a spend window or concurrency quota is exhausted.

#### Scenario: Daily cap reached
- **WHEN** recorded spend since the start of the day reaches `maxCostUsdPerDay`
- **THEN** a new run or work item is refused with `factory_budget_exhausted`
- **AND** the response includes the cap and the recorded spend

#### Scenario: Monthly cap reached
- **WHEN** recorded spend since the start of the month reaches `maxCostUsdPerMonth`
- **THEN** a new run or work item is refused with `factory_budget_exhausted`

#### Scenario: Concurrency reached
- **WHEN** the number of pending/running runs reaches `maxConcurrentRuns`
- **THEN** a new run is refused with `factory_quota_exhausted`
- **AND** no workflow is started

#### Scenario: Under quota
- **WHEN** spend and active runs are below every configured cap
- **THEN** admission succeeds

### Requirement: Budget reporting

The budget endpoint SHALL report lifetime, daily, monthly and concurrency usage in one response.

#### Scenario: Read budget
- **WHEN** a factory with quotas is read
- **THEN** the response contains `spentUsd`, day/month spend with caps and exhaustion flags, and
  active runs against the concurrency cap
- **AND** an unconfigured cap is reported as absent, not as zero
