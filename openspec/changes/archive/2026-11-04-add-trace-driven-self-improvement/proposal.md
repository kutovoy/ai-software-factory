# Proposal

## Why

Self-improvement proposals are driven by scored failures, but the scoring context drops most
of the run trace: usage, assistant message volume, file edits and review verdicts. That makes
“redundant tests”, “verbosity”, “scope” and “review usefulness” impossible to score, so the
observer only sees coarse pass/fail labels.

## What Changes

- Extend `RunEvidence` with deterministic trace data: usage, assistant message volume, file
  edits, patch bytes and the review gate verdict.
- Add four trace checks to the deterministic scorer family: `redundant_tests`, `verbosity`,
  `scope`, `review_usefulness`.
- Populate the trace from the canonical event log and `gate_decisions.verdict`.
- Expose the same metrics on `GET /runs/:id` and render them on the run detail page.
- Add a trace scorer to `hello-nextjs` so trace failures become normal scores, which flow
  through the existing observer → probe → compose → definition PR path.

## Capabilities

### New Capabilities
- None.

### Modified Capabilities
- `measurement`: deterministic trace checks and trace evidence on run detail.
- `self-improvement`: proposals can cite trace scores (redundant tests, verbosity, scope,
  review usefulness) as evidence.

## Impact

- `packages/evals/src/{types,trace,deterministic,judge}.ts`
- `packages/orchestration/src/scoring/context.ts`
- `apps/api/src/runs.ts`, `apps/web/src/lib/types.ts`, run detail page
- `factories/hello-nextjs/scorers/trace/scorer.md`
- Tests: `packages/evals/test/trace.test.ts` plus updated evidence fixtures.

## Non-goals

- No new LLM judge; trace checks are deterministic.
- No new database table: trace metrics are derived from events on read.
- No change to the existing scorer/proposal/canary/merge-queue contracts.
