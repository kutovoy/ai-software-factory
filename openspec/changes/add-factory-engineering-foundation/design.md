# Design

## Context

The roadmap items are related but must stay independently testable. The design keeps
validation, readiness, guard checks and metrics as pure core modules; the API projects them;
orchestration consumes only the workflow-safe validation types.

## Decisions

### 1. Validation contract is a persisted work-item artifact

- The contract is built deterministically at work-item creation from:
  - the factory's optional `validation` block;
  - inferred `package.json` scripts (`typecheck`, `lint`, `test`, `build`, `e2e`);
  - an explicit acceptance check for the item title.
- It is stored in `work_items.input.validationContract` so a retry keeps it.
- The contract carries `enforce`; enforcement is off by default so existing factories keep
  working until they opt in.
- The verify stage receives a fenced-JSON evidence instruction; the QA agent can report
  `{validation:[{id,status,evidence}]}`. Forge check names are mapped to contract ids as a
  second evidence source.
- A verify gate cannot `approve` while required evidence is missing when `enforce` is true.
  Human decisions are refused by the API with `validation_incomplete`; agent gates are
  turned into `request_changes`.
- The work-item detail projects `contract`, per-check `status`, `complete` and missing ids.

### 2. QA pyramid is represented by tiers, not by a new agent

- Tiers are `unit`, `component`, `integration`, `e2e` and `manual`.
- The contract requires at least one check; the builder adds `unit` checks for typecheck,
  lint and tests, `integration` for build, `e2e` when a Playwright/e2e script exists, and
  `manual` for the acceptance criterion.
- The QA agent prompt is unchanged except for the contract evidence instruction; the
  existing Playwright QA agent is the e2e tier.

### 3. Readiness is deterministic and advisory by default

- `scanReadiness` reads the local checkout (`REPO_ROOT`) and the loaded definition.
- Repository checks: style, build, tests, typecheck, docs, dev environment, observability,
  security and task discovery. Factory checks: QA agent, two reviewers, gates, merge policy,
  required verdicts, scorers/benchmarks, secrets/MCP.
- Score 0–100; `ready` ≥ 80, `warn` ≥ 60, otherwise `not_ready`. Every check reports
  evidence and a remediation hint.
- `readiness.enforceAutonomy` is opt-in. When true, enabling autonomy without an override is
  refused with `readiness_not_ready`.

### 4. Guard hooks are pure and fail-closed

- `runGuardHooks` takes the branch, the applied files and the factory's `guard` config.
- Checks: protected branch, path containment (`..`, absolute paths, `.git/`), secret
  patterns, maximum changed files and maximum patch bytes, binary-file limit.
- It runs in `forgeOpenPullRequest` after the patch is applied and before the commit.
- A failure is non-retryable (`guard_failed`) and records `guard.failed`; a pass records
  `guard.checked`. No shell command is executed by a hook.
- `GET /guard-hooks` returns the resolved config and recent results.

### 5. Metrics are additive

- Existing metric keys stay; new keys are `humanInteractionsPerPr`, `autonomyRatio`,
  `costPerAcceptedChange`, `signalToProductionCycleTime`, `incidentMttHours` and
  `mergedCodeAgeDays`.
- `null` plus a reason is still mandatory when there is no data.
- `autonomyRatio` is the share of PR items with zero human gate/permission touchpoints.
- `costPerAcceptedChange` uses only `done` PR items.
- `incidentMttHours` uses incident items; `signalToProductionCycleTime` uses non-manual
  items; `mergedCodeAgeDays` is the average time since merge for merged PRs in the window.

### 6. Factory Stack is help-only

- The stack page is a typed help entry with a CSS/SVG diagram; it adds no API surface.
- It is linked from the dashboard and the concepts section.

## Grounding

- Validation/QA pyramid: <https://engineering.block.xyz/blog/testing-pyramid-for-ai-agents>,
  <https://dev.to/teppana88/how-i-validate-quality-when-ai-agents-write-my-code-481c>
- Agent readiness: <https://github.com/kodustech/agent-readiness>,
  <https://factory.com/articles/measuring-agent-readiness>
- Outcome metrics: <https://www.anthropic.com/research/measuring-agent-autonomy>,
  <https://getdx.com/blog/dora-metrics/>
- Guard hooks/secret scanning: <https://factory.com/articles/agent-generated-commit-secret-scanning>,
  <https://www.endorlabs.com/learn/when-the-guardrails-slip-the-case-for-hook-based-governance-across-agent-platforms>
- Factory stack: <https://www.warp.dev/articles/what-is-a-software-factory>,
  <https://x.com/zachlloydtweets/article/2097739116720910619>

## Risks and mitigations

- **False positives in secret scanning.** Patterns are deliberately narrow (known token
  prefixes and private-key headers); the guard reports the matched pattern name, never the
  secret value.
- **Readiness scans the wrong repository.** The report labels its root and the API exposes
  it; factories can override validation checks explicitly. Target-repo checkout is a later
  runner/forge concern.
- **Metric ambiguity.** Every card carries its definition and sample size; no metric is
  invented when the data is absent.
- **Contract enforcement breaking existing loops.** `enforce` defaults to false; only
  factories that opt in can block a verify gate.
