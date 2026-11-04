# Proposal

## Why

The factory can already run agents through a durable SDLC loop, but the loop is not yet
*trustworthy* at the point where autonomy widens. The research review in
`research/software-factory-ideas.md` identified the same gap across five conference talks:
a factory needs a machine-checkable validation contract, an agent-readiness score, outcome
metrics, deterministic guard hooks, and an explainable factory stack.

This change implements the first sprint of that roadmap (items 1–5). It does not implement
model routing, work intake, progressive context, governance or missions.

## What Changes

- **Validation contract + QA pyramid.** A work item gets a persisted validation contract
  (acceptance checks, tiers, commands, evidence requirements). The spec/QA stages see it;
  the verify gate refuses approval while required evidence is missing when enforcement is
  on. The work-item page projects the contract and its evidence.
- **Agent readiness.** A deterministic readiness report scores the local repository and the
  factory definition (tests, linters, typecheck, docs, dev environment, observability,
  security, task discovery, factory hygiene). It is advisory by default and can block
  autonomy through `readiness.enforceAutonomy`.
- **Outcome metrics.** The metrics endpoint adds human interactions per PR, autonomy ratio,
  cost per accepted change, signal-to-production cycle time, incident MTT and merged-code
  age, while keeping the existing v1 metric keys.
- **Deterministic guard hooks.** Pure, fail-closed checks run before a PR is committed:
  protected branch, path containment, secret patterns, patch size and binary-file limits.
  Results are recorded as `guard.checked` / `guard.failed` events and exposed by the API.
- **Factory Stack help page.** A help entry and diagram explain the 00–06 stack
  (factories-as-code, data/context, compute, inference, improvement, orchestration, access).

## Capabilities

### New Capabilities
- `validation-contract`: the machine-checkable contract a work item must satisfy, its
  evidence, and the verify-gate enforcement.
- `agent-readiness`: a deterministic readiness score for a repository and factory definition.
- `guard-hooks`: fail-closed deterministic checks before a pull request is committed.

### Modified Capabilities
- `factory-definition`: optional `validation`, `readiness` and `guard` blocks.
- `measurement`: additional outcome and autonomy metrics.
- `web-console`: readiness page, validation panel, dashboard metrics and Factory Stack help.

## Impact

- New core modules: `packages/core/src/validation`, `packages/core/src/readiness`,
  `packages/core/src/guard`.
- New API routes: `GET /api/v1/factories/{factoryId}/readiness`,
  `GET /api/v1/factories/{factoryId}/guard-hooks`.
- Work-item detail gains a `validation` projection; metrics gain new cards.
- Orchestration: verify-stage validation evidence and a pre-PR guard check.
- Web: readiness page and nav entry, work-item validation card, dashboard metrics, help entry.
- Tests: core unit tests, API integration/contract tests, Playwright coverage for the new pages.
- Documentation: README, STATUS, DECISIONS, HANDOVER and the research roadmap status.

## Non-goals

- No arbitrary shell hooks. Guard hooks are pure TypeScript checks with no side effects.
- No automatic remediation of readiness gaps.
- No model routing, work-intake sources, progressive context, governance levels or missions.
- No change to the existing `/api/v1` metric keys; new metrics are additive.
