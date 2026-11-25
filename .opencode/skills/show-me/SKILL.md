---
name: show-me
description: Explain a change, plan, architecture or UI visually before or after building. Use when a plan or review needs a mockup, diagram, table, chart or standalone HTML explainer so a human can understand it faster than reading a wall of text.
license: MIT
compatibility: opencode
metadata:
  source: project-local
  vendored: "2026-11-24"
  modifications: written for this factory; optimized for review gates and plan approval
---

# Show Me

## Overview

Humans are visual. A compact diagram, table, chart or HTML mockup is often a better review surface
than prose. Use this skill when a human must approve a plan, understand an architecture, or decide
whether a change is safe.

**Rule:** visual output must be grounded in real inputs. Never invent screenshots, metrics, flows or
UI states. If a value is unknown, say `unknown`.

## When to Use

- Before building: align on a UI mockup, screen flow, data model or architecture diagram.
- Before a review gate: produce a one-page HTML explainer with the diff shape, blast radius,
  assertions, proof and open questions.
- After verification: attach a screenshot, short video or Playwright report as proof.
- At a mission plan gate for medium/high-risk UI or architecture work.

## Output Contract

1. Prefer a standalone HTML artifact (`review.explainer` or a plan artifact) with:
   - title, intent, risk tier and plan reference
   - a small diagram (Mermaid or inline SVG) of components/call flow
   - a table of changed files, assertions, proof and open questions
   - links to the raw diff, run artifacts and plan
2. For a UI mockup: show the intended screen, states (empty/loading/error/success) and the
   acceptance assertion each state satisfies.
3. For an architecture change: show boundaries, dependency direction, data flow and the
   constraint the change must preserve.
4. Keep it under ~1200 words; one screen if possible.
5. Label model-written prose as such. Deterministic packet facts are the source of truth.

## Do Not

- Do not fabricate screenshots, test results, metrics or user feedback.
- Do not replace the deterministic review packet with a narrative.
- Do not produce a visual for a trivial one-line change unless the reviewer asks.
