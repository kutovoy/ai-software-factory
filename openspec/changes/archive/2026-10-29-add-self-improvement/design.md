# Design

## Context

Scored runs + calibrated judges + benchmark attestations exist. Harness² gives the mechanics: propose
invariant (general) and domain (repo-specific) edits, probe them on the same task, compose the winners, and
carry lessons forward in an experience library. Our twist: the *authority* to apply a change is a per-factory
setting, not a global constant.

## Goals / Non-Goals

**Goals:**
- Improvements are evidence-backed, diffable, and reversible.
- Authority is explicit, per factory, and changeable at any time through the normal definition path.
- Lessons accumulate per factory; promotion to a shared library is opt-in.
- Canary rollout is real: route a fraction of work to the candidate version and roll back automatically.

**Non-Goals:**
- No editing of gates/mergePolicy or the factory's own source code.
- No fine-tuning; the model stays fixed (Harness² premise).
- No cross-factory canaries.
- No automatic promotion of lessons.

## Decisions

1. **Authority in the definition.** `improvement.authority` is a manifest field; changing it is a definition
   change (commit/PR) with actor + reason recorded. The UI shows the diff and requires confirmation.
2. **Edits are file-scoped.** A proposal is a set of edits to `agents/*/agent.md`, `skills/*`, `routing.yaml`,
   `scorers/*`, `automations/*`. The validator rejects edits touching `gates`, `mergePolicy`, `runners`,
   or anything outside those paths (`edit_out_of_scope`).
3. **Propose → probe → compose (Harness² Loop 1).** Observer proposes k invariant + k domain edits; each is
   probed by re-running the same work item under matched conditions; a composer keeps edits that improved the
   contrastive signal. No ground truth required.
4. **Evidence, not vibes.** Each proposal records the scored runs that motivated it, failure counts, and the
   scorer rationales; impact = failed runs × cost saved/quality delta, used for ranking.
5. **Dedupe by root cause.** Proposals are clustered (same files + same failure signature) and merged into one
   ranked item, so humans see the top 3, not 33.
6. **Decision by authority.**
   - `propose_only`: open a PR against the definition repo; a human merges.
   - `auto_merge_on_benchmark`: require a passing benchmark non-regression for the candidate vs current
     version with calibrated judges, then merge; otherwise open a PR.
   - `canary`: publish `factory-vN+1-candidate`, route `canaryPercent` of new work items to it, compare
     scores/incidents against the stable version over a window, auto-rollback if regression exceeds threshold.
7. **Lessons.** Per-factory `INDEX.md` + `EXPERIENCE.md` entries `{cue, lesson, evidence, confidence}`;
   promotion to the shared library is an explicit action requiring evidence + a human.
8. **Everything is audited.** Proposal creation, probe results, decisions, merges, rollouts and rollbacks emit
   events and are queryable.

## Risks / Trade-offs

- **Self-reinforcing drift.** Mitigation: benchmark non-regression + calibration + canary + rollback + audit.
- **Probe cost.** Mitigation: cap k, sample work items, reuse cached runs where inputs match.
- **Canary routing complexity.** Mitigation: route at work-item creation by deterministic hash, keep both
  versions pinned and reversible.
- **Lesson contamination.** Mitigation: per-factory by default; promotion requires human sign-off.
