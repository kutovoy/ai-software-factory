# Tasks

## 1. Trace evidence

- [x] 1.1 Extend `RunEvidence` with usage, messages, file edits, patch bytes and review.
- [x] 1.2 Populate trace fields from `events` and `gate_decisions.verdict`.
- [x] 1.3 Compute `TraceMetrics` deterministically.

## 2. Trace scoring

- [x] 2.1 Add `redundant_tests`, `verbosity`, `scope`, `review_usefulness` checks.
- [x] 2.2 Route trace checks through `evaluateDeterministic`.
- [x] 2.3 Add a trace scorer to `hello-nextjs`.

## 3. Surface

- [x] 3.1 Return `trace` from `GET /runs/:id`.
- [x] 3.2 Render trace metrics on the run detail page.
- [x] 3.3 Add unit tests for metrics and checks.

## 4. Verification

- [x] 4.1 `bun run typecheck`.
- [x] 4.2 `bun test`.
- [x] 4.3 Recreate/rerun `hello-nextjs` after the change.
