# Design

## Decisions

1. **Risk tiers are per plan/feature, not a factory-wide boolean.** `governance.autonomyLevel` remains the
   kill-switch/coarse level. A new `governance.risk` block defines `low`/`medium`/`high` policy and
   `highRiskPaths`. The mission plan and each feature carry a derived `riskTier` plus reasons.
2. **Auto-approval is low-risk only.** The existing full-autonomy + benchmark-gate condition remains, but it
   now also requires `riskTier: low`. `medium` and `high` plans require a human plan gate. `high` work items
   require a human review gate and a human ship gate; auto-merge is never allowed for high risk.
3. **Maintainability is an assertion, not a dashboard-only metric.** Add `architecture` and `maintainability`
   to `VALIDATION_TIERS`. The verify gate treats them like any required assertion: missing evidence blocks
   approval. Where a repo has deterministic scripts, use them; otherwise the validator produces a concrete
   report with thresholds.
4. **Planning artifacts are optional schema fields with honest empty states.** Old plans keep validating.
   The planner fills them for non-trivial goals; small fixes may leave them brief. Mission Control renders
   what exists and never invents content.
5. **Vertical slices are explicit.** `MissionFeaturePlan.verticalSlice` states the end-to-end behavior;
   `kind: 'slice' | 'enabler'` distinguishes a real slice from scaffolding. A plan must contain at least one
   `slice`; enablers must state what later slice verifies them.
6. **The review packet is deterministic.** It is assembled from plan/evidence/diff data, not free-form model
   prose, so it is auditable. High-risk human review uses the packet as the decision surface; the raw diff
   remains available.
7. **Prefer `sourceRef`/plan JSON over a migration in P0.** Risk tier travels in the mission plan and work
   item source ref. Add a DB column only if filtering/indexing demands it in a later change.

## Risks

- Risk classification can be gamed or wrong. Mitigate with explicit `highRiskPaths`, conservative defaults,
  and an audited override path.
- Maintainability thresholds can be noisy or repo-specific. Make them configurable, start with a small set
  (dependency cycles, duplication, diff size, new dependencies) and record the metric used.
- More plan fields can become ceremony. Keep them optional and short for small changes; the plan gate should
  show only what matters.
- Human review for high risk reduces throughput. That is the point: autonomy is bounded by verification
  capacity, not by a global full/off switch.

## Data flow

```text
goal ──▶ planner ──▶ plan {riskTier, productReview, architecture, programDesign,
                           validationContract{architecture/maintainability}, verticalSlices}
                     │
                     ├─ low + autonomy + benchmark ──▶ auto-approve
                     └─ medium/high ─────────────────▶ human plan gate
                                                     │
                     feature work item ◀─────────────┘
                           │
                           ├─ review/verify evidence ──▶ review packet
                           ├─ high risk ──▶ human review gate + human ship gate
                           └─ low risk ──▶ agent review + auto_on_green
```

## Acceptance themes

- Old definitions/plans validate unchanged.
- A high-risk plan cannot auto-approve or auto-merge.
- A medium/high plan cannot pass validation without architecture/maintainability evidence.
- A non-trivial plan shows product review, architecture, program design and vertical slices.
- A review packet is visible in work-item detail and Inbox.
