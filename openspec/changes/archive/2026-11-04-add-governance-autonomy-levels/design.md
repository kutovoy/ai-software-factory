# Design

## Context

Factory stages are unattended and `autoAllowPermissions` currently allows every tool action.
Autonomy is a binary kill switch. Models are pinned per run but there is no factory-level
allowlist. Audit lives in run steps/events but has no policy projection.

## Decisions

### 1. Governance block

`factory.yaml.governance` is optional and strict. `autonomyLevel` defaults to `auto`.
`allowedModels` is a glob list; `denyActions` and `requireHumanActions` are action globs.
`audit.export` defaults to `jsonl`; `otlpEndpoint` is recorded but not required.

### 2. Deterministic action policy

`evaluateActionPolicy` checks deny globs, then human-required globs, then the autonomy level.
`observe` and `assist` return `require_human` for unattended actions; `auto` and `full` allow
anything not explicitly denied. The workflow denies `require_human` actions in unattended
runs and records a `policy` step; it does not silently allow them.

### 3. Model allowlist

`assertModelAllowed` is called when resolving stage and run models. A model outside the list
fails with `model_not_allowed` before a run starts. The existing per-run proxy allowlist is
unchanged.

### 4. Audit

Policy decisions are `run_steps` with `kind='policy'` and detail `{action, decision, reason}`.
`GET /governance` returns the config, live autonomy state and the latest 20 decisions;
`GET /governance/audit` returns the same decisions with the configured export mode.

### 5. Autonomy level vs kill switch

The autonomy kill switch remains authoritative and separate. `governance.autonomyLevel`
describes what an unattended run may do; the kill switch stops dispatch entirely.

## Risks / Trade-offs

- Action names are coarse (`bash`, `git.push`); a deny glob may not see a command inside a
  bash action. The policy is a guardrail, not a sandbox; the runner sandbox remains the hard
  boundary.
- `observe`/`assist` factories will deny tool actions in unattended stages; that is the
  intended safe default.
- OTEL export is a recorded configuration; a collector integration is future work.

## Migration

No schema migration. Definitions without `governance` keep the previous behaviour.
