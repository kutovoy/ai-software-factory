---
name: interview-me
description: Extracts what the requester actually wants instead of what they think they should want, through a one-question-at-a-time interview with a hypothesis and confidence number, until ~95% confidence. Use at triage or before a spec when an ask is underspecified ("build me X" without who/why/success), or when requirements are being silently guessed.
license: MIT
compatibility: opencode
metadata:
  source: https://github.com/addyosmani/agent-skills
  upstream: skills/interview-me
  vendored: "2026-10-28"
  modifications: trimmed; reframed for the factory triage stage; downstream handoff points to OpenSpec propose instead of upstream skills
---

# Interview Me

## Overview

What people ask for and what they actually want are different things. The cheapest moment to find that
gap is before any plan, spec, or code exists. Once building starts, switching costs are real and the
misfit gets rationalised into "good enough".

This skill produces a **confirmed statement of intent** — the input to the next stage, not a spec.

## When to Use

Use at triage, or before proposing an OpenSpec change, when the ask is missing at least one of: **who**
it is for, **why** now, what **success** looks like, what the binding **constraint** is.

Also when the request is conventional rather than specific ("build me a dashboard", "make it faster"),
or when you notice yourself filling in ambiguous requirements before writing them down.

**Not for:** unambiguous self-contained asks ("rename this variable"), pure information requests,
mechanical operations, or when the requester explicitly asked for speed over verification.

## Loading Constraint

This skill needs a live, responsive human. In a non-interactive context (CI, scheduled automation, an
autonomous factory run with all gates `agent`), do **not** interview: record the open questions as a
blocker in the work item and let the gate decide. Guessing silently is the failure mode this skill exists
to prevent.

## The Process

### Step 1 — Hypothesise, with a confidence number

Before asking anything, write your best read in one sentence plus an honest 0–100% confidence:

```
HYPOTHESIS: You want a way to answer "how are we doing?" in standup, and "dashboard" was the convention.
CONFIDENCE: ~30% — missing: who it's for, what "metrics" means here, what success looks like
```

Below ~70%, append one line naming what is still unresolved. A high number you cannot defend is worse
than a low one.

### Step 2 — One question at a time, each with a guess attached

```
Q:     <one focused question>
GUESS: <your hypothesis, with the reasoning that produced it>
```

Wait for the reaction before the next question. Batching produces skimmed, surface answers, and the
third question usually depends on the first. Attaching a guess lets the requester react instead of
generating from scratch, and exposes *your* assumptions — which is the point.

### Step 3 — Listen for "want" vs "should want"

Dangerous answers are the ones that sound like a thoughtful answer rather than what the person wants:
"scalable", "clean architecture", "the standard approach", "I think I'm supposed to…", "good practice
says…". When you hear them ask:

> *"If you didn't have to justify this to anyone, what would you actually want?"*

### Step 4 — Restate in their own words

Tight, 5–8 lines, their language, confirmable line by line:

```
Outcome:      <one line>
User:         <who benefits>
Why now:      <what changed>
Success:      <how we know it worked>
Constraint:   <the binding limit>
Out of scope: <what we are explicitly not doing>
```

"Out of scope" is non-negotiable — half of misalignment is silent disagreement about non-goals.

### Step 5 — Confirm with an explicit yes

Not a yes: "whatever you think is best" (delegation — re-ask with two concrete options), "sounds good"
(ambiguous — ask "anything you'd refine?"), "sure, let's go" (often a polite exit), silence.

If corrected, fold it in and restate. Loop until an explicit yes.

### Step 6 — Stop the turn

Deliver the confirmed statement of intent and stop. Do not start downstream work in the same turn.

## The 95% Stop

You are done when you can predict the requester's reaction to the next three questions you would ask.
That is a checkable test, not a vibe. It also has a floor: if several rounds pass and confidence is not
rising, something foundational is missing — say so and step back rather than grinding.

## Output and Handoff

The deliverable is the confirmed statement of intent. Hand it to:

- **`openspec-propose`** — turn the intent into a proposal, spec delta and tasks (the normal path here)
- **`idea-refine`-style exploration** — only if the intent is "I want X but don't know how to scope it"
- **Task breakdown** — two hops downstream, after the spec exists

When handing off, frame the work in terms of the confirmed intent, not the original underspecified ask.

## Common Rationalisations

| Excuse | Reality |
|---|---|
| "The ask is clear enough" | If you can't state the desired outcome in one sentence now, it isn't. |
| "Questions waste their time" | 4–6 targeted questions are cheap; building the wrong thing is not. |
| "I'll figure it out as I build" | Discovery during implementation is rework at 10x cost. |
| "They said 'whatever you think'" | That's delegation, not decision. Offer two concrete options. |
| "We've talked enough, I get it" | Test it: predict their reaction to the next three questions. |

## Red Flags

- Three or more questions in one message (that's batching)
- A question with no hypothesis attached (that's surveying)
- Accepting "whatever you think is best" as terminal
- Writing a spec or tasks before an explicit yes
- Accepting a sophistication-signalling answer without probing
- Starting downstream work in the same turn as the confirmation

## Verification

- [ ] Hypothesis + confidence stated first, with a reason when below ~70%
- [ ] Questions asked one at a time, each with a guess
- [ ] Concrete restate including Out of scope
- [ ] Explicit yes received (not "sounds good", not silence)
- [ ] Turn stopped after confirmation; handoff framed as the confirmed intent
