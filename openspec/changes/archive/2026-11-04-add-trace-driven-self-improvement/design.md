# Design

## Context

`buildRunContext` (`packages/orchestration/src/scoring/context.ts`) builds a neutral
`RunEvidence` for deterministic scorers and judge prompts. It currently forwards artifacts,
artifact bodies and tool calls, but drops `usage.updated`, `message.*`, `file.edited` and the
review gate verdict. The observer (`packages/evals/src/improve/observer.ts`) can only cluster
failures from the scores it receives.

## Decisions

### 1. Trace checks are deterministic checks

The four new checks live in the existing deterministic family rather than a new scorer class.
That keeps the registry, scoring activity, score records and observer unchanged: a trace
failure is a normal score with `passing: false`, and a scorer with `selfImprovement: true`
automatically feeds the existing proposal path.

### 2. Trace evidence is derived, not stored

`buildRunContext` reads the canonical `events` table and the latest `gate_decisions.verdict`
for the work item. It computes:

- usage: last `usage.updated`;
- messages: assistant `message.completed` count, total chars and final-message chars;
- file edits: `file.edited` path, diff bytes, added/removed lines;
- scope: unique changed files and `patch.diff` bytes;
- review: verdict decision, finding count and summary length.

No migration is needed. The metrics are reproducible from the append-only log.

### 3. Thresholds are conservative

Defaults: 6,000 output tokens, 20,000 assistant chars, 20 changed files, 200,000 patch bytes,
at least one finding and a 40-char review summary. These flag waste, not normal variation;
factories can add their own scorer rubrics if they need tighter bounds.

### 4. Review usefulness is not applicable outside review runs

A non-review run passes `review_usefulness` with an explicit `not a review run` rationale.
This avoids turning every implement run into a failure when no review gate exists yet.

### 5. Run detail exposes the same metrics

`GET /runs/:id` returns `trace` and the run page renders four compact cards. This makes the
evidence inspectable without a separate traces page or a new nav item.

## Risks / Trade-offs

- Deriving trace metrics on every run-detail read adds one events query; the run page already
  reads steps/permissions, and the event volume is bounded.
- A review gate may be decided after the run; the latest verdict is used, so a re-read can
  change the review metric. The score keeps the evidence it was produced with.
- Trace thresholds are global defaults; a factory can override them with a custom scorer.

## Migration

No schema migration. Add the trace scorer to a factory definition to start producing trace
scores; existing factories keep working unchanged.
