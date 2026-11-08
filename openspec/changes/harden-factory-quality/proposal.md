# Proposal

## Why

The live `hello-nextjs` mission proves the factory can run a small greenfield goal unattended, but it does
not prove that autonomous work preserves maintainability in a complex, long-lived codebase. Research and
industry telemetry point to the same failure mode: generation is cheap, verification and human
comprehension are scarce; models trained on test-pass rewards do not reliably protect architecture or
future change cost. A factory-wide `autonomyLevel: full` switch is too coarse, and build/e2e evidence alone
can pass while coupling, duplication and comprehension debt worsen.

The detailed findings and P0/P1/P2 plan are in `docs/SOFTWARE_FACTORY_WEAKNESSES.md`.

## What Changes

- **Risk-tiered autonomy:** low/medium/high risk tiers with per-tier plan approval, review and merge policy;
  high-risk changes always require human plan/review/merge, even under full autonomy.
- **Architecture and maintainability assertions:** add `architecture` and `maintainability` validation tiers,
  built-in check templates and threshold evidence; medium/high-risk runnable goals must include them.
- **Planning artifacts:** mission plans gain optional product review, system architecture, program design
  and vertical-slice sections; the planner and Mission Control surface them before approval.
- **Vertical slices:** features declare the end-to-end behavior they deliver (or justify an enabler), and
  plans must contain at least one slice.
- **Review packet:** a deterministic compact packet (intent, plan, diff stats, evidence, architecture impact,
  open questions) on work-item detail and Inbox; high-risk work items require a human review gate.

## Capabilities

### Modified Capabilities

- `factory-definition`: risk-tier governance and high-risk path rules.
- `missions`: risk-tiered plan approval, design artifacts, vertical slices.
- `validation-contract`: architecture and maintainability assertions.
- `web-console`: plan design review, review packet and high-risk gates.

## Impact

- Schema additions are backward-compatible defaults; existing factories and plans must still validate.
- Orchestration: mission planner, mission auto-approval, factory gates/merge policy, review packet event.
- Web: Mission Control plan card, work-item detail, Inbox.
- Tests: schema, planner, workflow, validation, Playwright; docs/help updates.
- No runner or provider-key change.
