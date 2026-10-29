# Spec Delta

## Purpose

Defines the self-improvement loop: evidence-backed proposals, contrastive probing, composition, an authority
setting that governs how changes land, a per-factory experience library, and canary rollout with rollback.

## ADDED Requirements

### Requirement: Authority levels

Each factory SHALL declare an improvement authority of `propose_only`, `auto_merge_on_benchmark`, or `canary`,
and the authority SHALL govern how proposals are applied.

#### Scenario: Propose only
- **WHEN** authority is `propose_only`
- **THEN** an accepted proposal is opened as a pull request against the definition repo
- **AND** it is never merged automatically

#### Scenario: Auto-merge on benchmark win
- **WHEN** authority is `auto_merge_on_benchmark`
- **THEN** a proposal merges only if a benchmark shows non-regression for the candidate against the current
  version with calibrated judges
- **AND** otherwise it is opened as a pull request

#### Scenario: Canary
- **WHEN** authority is `canary`
- **THEN** the candidate is published as a candidate version and routed a configured percentage of new work
- **AND** it is promoted or rolled back based on the observation window

#### Scenario: Authority change
- **WHEN** the authority is changed
- **THEN** it is a definition change recorded with actor, reason and diff
- **AND** it takes effect for proposals created afterwards

### Requirement: Blast radius

Proposals SHALL only edit agent instructions, skills, model routing, scorer rubrics and automation triggers.

#### Scenario: Allowed edit
- **WHEN** a proposal edits `agents/*/agent.md`, `skills/*`, `routing.yaml`, `scorers/*` or `automations/*`
- **THEN** it is accepted for probing

#### Scenario: Forbidden edit
- **WHEN** a proposal edits `gates`, `mergePolicy`, `runners`, or any file outside the allowed paths
- **THEN** it is rejected with `edit_out_of_scope`
- **AND** the attempt is recorded

### Requirement: Evidence-backed proposals

Every proposal SHALL cite the scored runs and failures that motivated it, and SHALL be ranked by impact.

#### Scenario: Evidence
- **WHEN** an observer agent creates a proposal
- **THEN** it records the source run ids, failure counts, scorer rationales and the proposed diff
- **AND** it records an impact score derived from failed runs and their cost

#### Scenario: Dedupe
- **WHEN** multiple proposals share the same files and failure signature
- **THEN** they are clustered into one item with a combined evidence set
- **AND** the ranked list shows the highest-impact items first

### Requirement: Contrastive probe and compose

Each candidate edit SHALL be probed by re-running the same work under matched conditions, and only edits that
improve the contrastive signal SHALL be composed into the candidate version.

#### Scenario: Probe
- **WHEN** a proposal is probed
- **THEN** the same work item runs with the candidate and the baseline under matched inputs
- **AND** the outcome difference is recorded per edit

#### Scenario: Compose
- **WHEN** probing completes
- **THEN** winning edits are composed into one candidate definition
- **AND** losing edits are recorded as rejected with their contrast result

#### Scenario: No signal
- **WHEN** no edit improves the signal
- **THEN** no candidate version is produced
- **AND** the proposal is closed as `no_improvement`

### Requirement: Experience library

Lessons SHALL be stored per factory and MAY be promoted to a shared library by explicit human action.

#### Scenario: Record
- **WHEN** a proposal is accepted or rejected
- **THEN** a lesson `{cue, lesson, evidence, confidence}` is appended to the factory's `EXPERIENCE.md`
- **AND** `INDEX.md` gains an entry keyed by cue

#### Scenario: Promotion
- **WHEN** a human promotes a lesson to the shared library
- **THEN** the lesson records its origin factory, evidence and approver
- **AND** it becomes visible to other factories as a suggestion, never auto-applied

#### Scenario: Isolation
- **WHEN** a factory has not promoted a lesson
- **THEN** other factories cannot read it

### Requirement: Canary rollout and rollback

A canary rollout SHALL route a configured fraction of new work to the candidate version and SHALL roll back
automatically on regression.

#### Scenario: Route
- **WHEN** a canary is active
- **THEN** new work items are assigned to stable or candidate by deterministic hash at the configured percentage
- **AND** each item records the version it ran

#### Scenario: Promote
- **WHEN** the observation window completes with no regression beyond the threshold
- **THEN** the candidate is promoted to the stable version
- **AND** the previous version remains available for rollback

#### Scenario: Rollback
- **WHEN** scores or incidents regress beyond the threshold
- **THEN** routing returns to the stable version immediately
- **AND** a `canary.rolled_back` event records the reason and the evidence

#### Scenario: Manual rollback
- **WHEN** a human triggers rollback
- **THEN** routing returns to stable regardless of the window
- **AND** the action is audited
