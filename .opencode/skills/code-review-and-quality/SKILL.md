---
name: code-review-and-quality
description: Conducts multi-axis code review. Use before merging any change, and when reviewing code written by yourself, another agent, or a human. Use when asked to review a diff or pull request, even when the diff is pasted inline, or when a factory stage gate requires a review verdict.
license: MIT
compatibility: opencode
metadata:
  source: https://github.com/addyosmani/agent-skills
  upstream: skills/code-review-and-quality
  vendored: "2026-10-28"
  modifications: trimmed to fit repo budget; commands adapted to Bun/TypeScript; added factory gate wording
---

# Code Review and Quality

## Overview

Every change gets reviewed before merge — no exceptions. Review covers five axes: correctness,
readability, architecture, security, performance.

**Approval standard:** approve when the change definitely improves overall code health, even if it
isn't perfect. Don't block a change just because it isn't how you would have written it.

## When to Use

- Before merging any PR or change, and at any `review` / `pr_review` gate in a factory run
- After finishing a feature, a refactor, or a bug fix (review the fix *and* the regression test)
- When another agent or model produced code you must evaluate

## The Five-Axis Review

### 1. Correctness
- Does it match the spec or task requirements? Are edge cases (null, empty, boundary) handled?
- Are error paths handled, not just the happy path? Off-by-one, races, stale state?
- Do the tests actually test the right thing (see `test-driven-development`)?

### 2. Readability & Simplicity
- Names descriptive and consistent with repo conventions; no `temp`, `data`, `result` without context.
- Straightforward control flow; no clever tricks. Could this be fewer lines?
- No dead artifacts: no-op variables, backwards-compat shims, `// removed` comments.
- A new conditional bolted onto an unrelated flow is a design smell, not a nit.
- Repeated conditionals on the same shape signal a missing model or dispatcher.

### 3. Architecture
- Follows existing patterns; if new, is it justified? Clean module boundaries, no cycles.
- Does the refactor reduce complexity or just relocate it? Count the concepts a reader must hold.
  Prefer the restructuring that makes whole branches or layers disappear.
- Feature-specific logic leaking into a shared module; near-duplicate of a canonical helper.
- Explicit type boundaries: question gratuitous `any`, optional, casts, silent fallbacks.

### 4. Security
Detailed guidance lives in `security-and-hardening`. Ask: input validated at the boundary? secrets out
of code and logs? authz checked per resource? queries parameterized? output encoded? external and
**agent/LLM-produced** data treated as untrusted?

### 5. Performance
N+1 queries, unbounded loops or fetches, sync work that should be async, missing pagination, large
objects in hot paths.

## Structural Remedies

When flagging a structural problem, propose the move, not just the complaint: replace conditional
chains with a typed model or dispatcher; collapse duplicate branches; separate orchestration from
business logic; move feature logic to its owning package; reuse the canonical helper; make a type
boundary explicit; delete a pass-through wrapper; extract a helper or split a large file.

## Change Sizing

```
~100 lines changed  → good, reviewable in one sitting
~300 lines changed  → acceptable if one logical change
~1000 lines changed → too large, split it
```

Watch file size too: a small diff that pushes a file past ~1000 total lines is a signal to decompose
first. Separate refactoring from feature work. Keep the change description standalone and imperative.

## Review Process

1. **Understand intent** — what spec/task does this implement, what behaviour should change?
2. **Review tests first** — do they test behaviour, not implementation? Cover edge cases?
   Verify by experiment: invert one condition the change adds, run the suite, restore. A mutation that
   stays green is a finding — name the missing test.
3. **Walk the implementation** with the five axes, file by file.
4. **Categorise findings** by severity so the author knows what is required:

   | Prefix | Meaning | Action |
   |---|---|---|
   | *(none)* | Required change | Must address before merge |
   | **Critical:** | Blocks merge | Security, data loss, broken behaviour |
   | **Nit:** | Optional | Formatting, style preference |
   | **Optional:** / **Consider:** | Suggestion | Worth weighing |
   | **FYI** | Informational | No action |

   Lead with what matters: correctness and security first, cosmetics last. One structural problem and
   ten nits means the structural problem *is* the review.
5. **Verify the verification** — which commands ran, did the build/typecheck pass, was the runtime
   behaviour observed, is there a before/after?

## Multi-Model Review

Model A writes → Model B reviews correctness and architecture → Model A addresses → human decides.
Different models have different blind spots; this is the default shape for an agent review gate.

## Dependency Discipline

Before adding a dependency: does the existing stack solve it, how large is it, is it maintained, does
it have known vulnerabilities, is the license compatible? Prefer the standard library. Upgrade one
dependency per change, read the changelog, review the lockfile diff, and let a green suite decide.

## Dead Code Hygiene

After refactoring, list orphaned code explicitly and **ask before deleting** anything you are not sure
about. Never silently remove code that might be someone's in-flight work.

## Honesty

- Don't rubber-stamp: "LGTM" with no evidence helps no one.
- Don't soften real issues, and don't inflate nits into blockers.
- Quantify when possible ("this N+1 adds ~50 ms per item") instead of "this could be slow".
- Comment on code, not people. Accept an informed override gracefully.

## Common Rationalisations

| Excuse | Reality |
|---|---|
| "It works, that's good enough" | Unreadable, insecure or mis-architected code compounds into debt. |
| "I wrote it, so I know it's correct" | Authors are blind to their own assumptions. |
| "We'll clean it up later" | Later never comes; the review is the gate. |
| "AI-generated code is probably fine" | Agent code needs *more* scrutiny: it is confident and plausible even when wrong. |
| "The tests pass, so it's good" | Tests don't catch architecture, security or readability problems. |
| "It's just a version bump" | A bump is behaviour you didn't write. Read the changelog. |

## Red Flags

- Merged without review, or review that only checks that tests pass
- Security-sensitive change with no security-focused pass
- Bug fix with no regression test; review comments with no severity labels
- A "refactor" that relocates complexity instead of removing it
- Bulk dependency bumps with no per-package isolation

## Verification

- [ ] All Critical and Required findings resolved or explicitly deferred with justification
- [ ] `bun test` and `bun run typecheck` pass (or the repo's documented equivalents)
- [ ] Verdict recorded: **Approve** or **Request changes**, with the evidence behind it
