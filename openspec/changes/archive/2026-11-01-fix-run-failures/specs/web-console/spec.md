# Spec Delta

## ADDED Requirements

### Requirement: Non-overlapping run metadata

Run metadata cells SHALL not overlap, including long commit SHAs.

#### Scenario: Long commit
- **WHEN** a run page renders a 40-character commit
- **THEN** the cell shows a short SHA with the full value available
- **AND** it does not overlap the harness/model cell

#### Scenario: Narrow viewport
- **WHEN** the page is narrower than the four-column breakpoint
- **THEN** cells reflow without horizontal overflow
