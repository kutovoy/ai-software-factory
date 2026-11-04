# Proposal

## Why

Autonomy is binary (enabled/paused), model allowlisting is only per-run proxy plumbing, and
there is no per-action policy. Roadmap item 10 asks for governance and autonomy levels: risk
classes, per-action allow/deny, model allowlists and audit export.

## What Changes

- Add an optional `governance` block to `factory.yaml`:
  `autonomyLevel` (`observe|assist|auto|full`), `allowedModels`, `denyActions`,
  `requireHumanActions`, and audit export (`jsonl|otel` + OTLP endpoint).
- Add a deterministic action policy used by unattended runs: deny or require-human actions
  are denied and recorded; `observe`/`assist` never auto-allow.
- Enforce the model allowlist when resolving stage and run models.
- Record policy decisions as `policy` run steps and expose them through
  `GET /factories/:factoryId/governance` and `/governance/audit`.
- Keep SSO/OIDC out of scope: it remains blocked on an IdP decision.

## Capabilities

### New Capabilities
- None.

### Modified Capabilities
- `factory-definition`: optional `governance`.
- `factory-loop`: per-action policy and model allowlist.
- `run-lifecycle`: policy decisions are recorded on the run.

## Impact

- `packages/core/src/{schema/factory,governance/policy,stage-graph/resolve}.ts`
- `packages/orchestration/src/{types,workflows/run,workflows/stage,workflows/factory}.ts`
- `apps/api/src/{runs,work-items,governance,app,errors}.ts`, `apps/api/openapi.json`
- `factories/hello-nextjs/factory.yaml`
- Tests: governance policy.

## Non-goals

- No SSO/OIDC implementation; it needs an IdP and group mapping decision.
- No external OTEL collector in compose; the audit export is exposed as a JSON projection.
- No change to the autonomy kill switch semantics.
