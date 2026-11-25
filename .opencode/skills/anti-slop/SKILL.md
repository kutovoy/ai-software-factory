---
name: anti-slop
description: Prevent low-quality AI-generated code before review. Use when implementing, reviewing or verifying a change, especially when the diff is large, adds dependencies, duplicates logic, or touches public APIs.
license: MIT
compatibility: opencode
metadata:
  source: project-local
  vendored: "2026-11-24"
  modifications: written for this factory; combines deterministic rules with review heuristics
---

# Anti-Slop

## Overview

Slop is production that costs the reader more to understand than it cost to produce. Fight it with
deterministic checks first, then judgment. Prefer subtracting over adding.

## Deterministic Rules

Run the repository's `anti-slop`, `lint:anti-slop` or `quality:anti-slop` script when present.
If it is absent, apply these rules manually and report the result:

- No `any`, `@ts-ignore`, `@ts-expect-error` or casts used to silence a real type problem.
- No dead code, commented-out code, unused exports, no-op variables or backwards-compat shims.
- No duplicate utility/helper when an existing abstraction fits; search first.
- No new dependency without a one-line justification and a check that the standard library or an
  existing dependency cannot do it.
- No swallowed errors (`catch {}` / bare `except`) and no error handling that only logs.
- No `console.log` in production paths; use the repo logger.
- No public API/schema change without a contract test or migration note.
- No test weakening: do not delete, skip or loosen a test to get green.
- Prefer a small vertical slice over a horizontal layer.

## Language Notes

- TypeScript: avoid `%s`-style formatting in new code; use template strings. Avoid tuple-returning
  error handling when the repo uses exceptions/Result types.
- Python: avoid bare `except`, mutable default arguments, `%` formatting, and tuple error returns
  when exceptions are the house style.

## Review Heuristics

- Can a reviewer understand the change in under 10 minutes? If not, split it.
- Does the diff stay inside the stated scope? Unrelated files are a smell.
- Does it reuse the existing architecture, or invent a parallel one?
- Is there proof (test, screenshot, curl, report) for every behavioral claim?
- Would the next agent copy this pattern? If yes, make it good.

## Output

Report each violation with `file:line`, rule and a one-line fix. If no script exists, say
`anti-slop: not configured` rather than claiming a pass.
